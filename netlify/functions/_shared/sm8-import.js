// Read-only ServiceM8 reader for the move off ServiceM8 (item 111, Settings > ServiceM8 Import).
// Nothing in here writes to ServiceM8: it only GETs.
//
// loadSm8Everything() pulls the whole account in a handful of bulk calls (ServiceM8's filter only
// does "and", so asking per job would be several calls per job and run into its daily limit),
// then groups everything under its main job: one record per job that comes across, holding the
// job, its lettered claim jobs, lines, notes, payments, contacts, check-ins, checklist and file
// list. That record is what _shared/sm8-run.js queues, writes from and keeps as the raw copy.
// buildJobStage() and stageFromLines() turn a job's ServiceM8 lines into the one stage it gets.
//
// Money: the app keeps every figure ex GST, ServiceM8's job total includes it, so totals are
// divided by 1.1.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const SM8_BASE = 'https://api.servicem8.com/api_1.0';

// ServiceM8 said slow down and kept saying it: the minute limit (about 180 calls) clears by
// itself, the daily one (about 20,000) does not, so the caller pauses the run and comes back.
class Sm8RateLimit extends Error {
  constructor(what) { super(`ServiceM8 rate limit (429) on ${what}`); this.rateLimited = true; }
}

// onPage: called after each page, so a long read can show it is still alive.
async function sm8GetAll(apiKey, object, filter, onPage) {
  // ServiceM8 pages large result sets: start with cursor=-1 and follow the
  // x-next-cursor header until it stops coming back. An account small
  // enough to fit in one page just never sends the header.
  const rows = [];
  let cursor = '-1';
  for (let page = 0; page < 2000 && cursor; page++) {
    // encodeURIComponent rather than URLSearchParams: the filter's spaces
    // need to go as %20, not +.
    const query = [`cursor=${encodeURIComponent(cursor)}`];
    if (filter) query.push(`%24filter=${encodeURIComponent(filter)}`);
    const url = `${SM8_BASE}/${object}.json?${query.join('&')}`;
    let res;
    // ServiceM8 allows roughly 180 calls a minute; when it says slow down
    // (429), wait a moment and try again rather than failing the job.
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
      if (res.status !== 429) break;
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
    }
    if (res.status === 429) throw new Sm8RateLimit(object);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ServiceM8 ${object} request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (Array.isArray(data)) rows.push(...data);
    if (onPage) await onPage();
    const next = res.headers.get('x-next-cursor');
    cursor = next && next !== cursor ? next : null;
  }
  return rows;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const exGst = (n) => r2((Number(n) || 0) / 1.1);
const isOn = (v) => v === 1 || v === '1' || v === true;
const clean = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

// Comparable forms for matching an SM8 company against existing clients:
// "Smith Electrical Pty Ltd" and "smith electrical" are the same client.
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(pty|ltd|limited|p\/l|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const normEmail = (s) => String(s || '').trim().toLowerCase();
function normPhone(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-9) : '';
}

// "4515b" -> { base: '4515', letter: 'b' }; a plain "4515" is not a claim.
function claimOf(job) {
  const m = String(job.generated_job_id || '').trim().match(/^(\d+)([a-z]+)$/i);
  return m ? { base: m[1], letter: m[2].toLowerCase() } : null;
}

function contactName(c) {
  return [c.first, c.last].map(clean).filter(Boolean).join(' ');
}

// First line of the job description, cut to a sensible length, for the
// suggested job name ("Client - Switchboard upgrade" like other Direct Jobs).
function shortTitle(description) {
  const first = clean(description).split('\n').map(l => l.trim()).find(Boolean) || 'ServiceM8 job';
  return first.length > 60 ? `${first.slice(0, 57).trim()}...` : first;
}

function noteDate(n) {
  const d = String(n.create_date || n.edit_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '0000-00-00' ? d : '';
}

function buildNotesText(job, notes) {
  const header = [`Imported from ServiceM8 job #${job.generated_job_id || '?'}.`];
  if (job.purchase_order_number) header.push(`Client PO: ${clean(job.purchase_order_number)}`);
  const parts = [header.join('\n')];
  const workDone = clean(job.work_done_description);
  if (workDone) parts.push(`Work done so far (ServiceM8):\n${workDone}`);
  if (notes.length) {
    parts.push('ServiceM8 notes:\n' + notes.map(n => `[${n.date || 'no date'}] ${n.text}`).join('\n\n'));
  }
  return parts.join('\n\n');
}

// Which TEops client a ServiceM8 company is. { clientId, reason } when it is sure: linked on an
// earlier import, or the same name with the same email or phone, or the same name where one side
// has no contact details to disagree with. Otherwise { clientId: null, lookalike }: it becomes a new
// client and the report names the client it looks like, to merge on the Clients page if it is one.
function matchClient(company, contacts, clients) {
  const byUuid = clients.find(c => c.sm8_company_uuid && c.sm8_company_uuid === company.uuid);
  if (byUuid) return { clientId: byUuid.id, reason: 'Linked on a previous import' };
  clients = clients.filter(c => !c.mergedAlias); // a merged client's second listing is only for the id match above

  const name = normName(company.name);
  const emails = new Set([company.email, ...contacts.map(c => c.email)].map(normEmail).filter(Boolean));
  const phones = new Set([company.phone, ...contacts.flatMap(c => [c.phone, c.mobile])].map(normPhone).filter(Boolean));
  const sameContact = (c) => emails.has(normEmail(c.email)) || phones.has(normPhone(c.phone));
  const nothingToCompare = (c) => (!emails.size && !phones.size) || (!normEmail(c.email) && !normPhone(c.phone));

  const nameHits = name ? clients.filter(c => normName(c.name) === name) : [];
  const withContact = nameHits.find(sameContact);
  if (withContact) return { clientId: withContact.id, reason: 'Same name and contact details' };
  if (nameHits.length === 1 && nothingToCompare(nameHits[0])) return { clientId: nameHits[0].id, reason: 'Same name' };
  if (nameHits.length) return { clientId: null, lookalike: `Same name as an existing client (${nameHits[0].name}) with different contact details` };
  const other = clients.find(sameContact);
  if (other) return { clientId: null, lookalike: `Same email or phone as ${other.name}` };
  return { clientId: null, lookalike: null };
}

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d > '2000-01-01';
const dateOf = (v) => { const d = String(v || '').slice(0, 10); return isDate(d) ? d : ''; };

// What a ServiceM8 job comes across as, by its own status. Unsuccessful (and anything else) stays behind.
const KIND_BY_STATUS = { Quote: 'quote', 'Work Order': 'job', Completed: 'completed' };

// The whole ServiceM8 account, grouped for the run. Returns:
//   companies  [{ uuid, name, email, phone, address, contacts: [{ name, email, phone, type }] }]
//   jobs       [{ uuid, number, kind ('quote' | 'job' | 'completed'), payload }], one per main job
//              that comes across; payload is the raw record described at the top of this file
//   left       jobs staying behind, counted by reason, and the lettered jobs with no main job
async function loadSm8Everything(apiKey, onPage) {
  // One after another, not all at once: nine paged lists side by side trip the minute limit.
  const get = (object, filter) => sm8GetAll(apiKey, object, filter, onPage);
  const allJobs = await get('job', 'active eq 1');
  // every company, archived ones too: a job of an archived client still needs its client
  const everyCompany = await get('company');
  const companyContacts = await get('companycontact', 'active eq 1');
  const jobContacts = await get('jobcontact', 'active eq 1');
  const notes = await get('note', "related_object eq 'job' and active eq 1");
  const materials = await get('jobmaterial', 'active eq 1');
  const bundles = await get('jobmaterialbundle', 'active eq 1');
  const payments = await get('jobpayment', 'active eq 1');
  const activities = await get('jobactivity', 'active eq 1');
  const checklist = await get('jobchecklist', 'active eq 1');
  const attachments = await get('attachment', "related_object eq 'job' and active eq 1");
  const taxRates = await get('taxrate');
  const staff = await get('staff');

  const group = (list, key) => list.reduce((m, x) => { (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x); return m; }, new Map());
  const contactsByCompany = group(companyContacts, 'company_uuid');
  const contactsByJob = group(jobContacts, 'job_uuid');
  const notesByJob = group(notes, 'related_object_uuid');
  const materialsByJob = group(materials, 'job_uuid');
  const bundlesByJob = group(bundles, 'job_uuid');
  const paymentsByJob = group(payments, 'job_uuid');
  const activitiesByJob = group(activities, 'job_uuid');
  const checklistByJob = group(checklist, 'job_uuid');
  const attachmentsByJob = group(attachments, 'related_object_uuid');
  const companyByUuid = new Map(everyCompany.map(c => [c.uuid, c]));
  const staffNames = Object.fromEntries(staff.map(s => [s.uuid, `${clean(s.first)} ${clean(s.last)}`.trim() || 'Unknown ServiceM8 staff']));

  // Lettered jobs (4515A deposit, 4515B claim...) belong to the main job of the same number.
  const mainJobs = allJobs.filter(j => !claimOf(j));
  const mainByNumber = new Map(mainJobs.map(j => [String(j.generated_job_id || '').trim(), j]));
  const letteredByMain = new Map();
  const orphanClaims = [];
  for (const j of allJobs) {
    const claim = claimOf(j);
    if (!claim) continue;
    const main = mainByNumber.get(claim.base);
    if (main) (letteredByMain.get(main.uuid) || letteredByMain.set(main.uuid, []).get(main.uuid)).push(j);
    else if (KIND_BY_STATUS[j.status]) orphanClaims.push(String(j.generated_job_id));
  }

  const left = { byStatus: {}, orphanClaims, letteredOfLeftJobs: 0 };
  const jobs = [];
  for (const job of mainJobs) {
    const kind = KIND_BY_STATUS[job.status];
    const lettered = (letteredByMain.get(job.uuid) || [])
      .sort((a, b) => String(a.generated_job_id).length - String(b.generated_job_id).length || String(a.generated_job_id).localeCompare(String(b.generated_job_id)));
    if (!kind) {
      left.byStatus[job.status || 'No status'] = (left.byStatus[job.status || 'No status'] || 0) + 1;
      left.letteredOfLeftJobs += lettered.length;
      continue;
    }
    // an Unsuccessful lettered job stays behind like any other: only its status is kept, for the claims
    const uuids = [job.uuid, ...lettered.filter(l => KIND_BY_STATUS[l.status]).map(l => l.uuid)];
    const every = (byJob) => uuids.flatMap(u => byJob.get(u) || []);
    const jobActivities = every(activitiesByJob);
    jobs.push({
      uuid: job.uuid,
      number: String(job.generated_job_id || '').trim(),
      kind,
      payload: {
        job,
        letteredJobs: lettered,
        company: companyByUuid.get(job.company_uuid) || null,
        companyContacts: contactsByCompany.get(job.company_uuid) || [],
        jobContacts: contactsByJob.get(job.uuid) || [],
        notes: notesByJob.get(job.uuid) || [],
        // lines and payments are the main job's own: a claim's sit on the claim job
        materials: materialsByJob.get(job.uuid) || [],
        bundles: bundlesByJob.get(job.uuid) || [],
        payments: paymentsByJob.get(job.uuid) || [],
        // check-ins, checklists and files on the lettered jobs are part of the job too
        activities: jobActivities,
        checklist: every(checklistByJob),
        attachments: every(attachmentsByJob),
        taxRates: Object.fromEntries(taxRates.map(t => [t.uuid, num(t.amount)])),
        staffNames: Object.fromEntries([...new Set(jobActivities.map(a => a.staff_uuid).filter(Boolean))].map(u => [u, staffNames[u] || 'Unknown ServiceM8 staff'])),
      },
    });
  }

  // the clients that come across: every active one, and an archived one when a job that comes across is its
  const needed = new Set(jobs.map(j => j.payload.job.company_uuid).filter(Boolean));
  const companies = everyCompany.filter(c => isOn(c.active) || needed.has(c.uuid));
  const contactRow = (c) => ({ name: contactName(c), email: clean(c.email), phone: clean(c.mobile) || clean(c.phone), type: String(c.type || '').toUpperCase(), primary: isOn(c.is_primary_contact) });
  return {
    companies: companies.filter(c => c.uuid).map(c => {
      const contacts = (contactsByCompany.get(c.uuid) || []).map(contactRow);
      const first = contacts.find(x => x.primary) || contacts[0] || {};
      return {
        uuid: c.uuid,
        name: clean(c.name) || first.name || 'Unknown client',
        email: clean(c.email) || (contacts.find(x => x.email) || {}).email || '',
        phone: clean(c.phone) || (contacts.find(x => x.phone) || {}).phone || '',
        address: clean(c.address || c.billing_address),
        contacts,
      };
    }),
    jobs,
    left,
  };
}

// The row _shared/sm8-job-writer.js writes, from a job's raw record. client: the TEops client it
// belongs to ({ id, name }), already settled by the run. tierNames: the rate tier names, to tell
// labour lines from materials.
function shapeSm8Job(kind, payload, tierNames) {
  const { job, letteredJobs = [], company, companyContacts = [], jobContacts = [], notes = [] } = payload;
  const number = String(job.generated_job_id || '').trim();
  const pick = (field) => {
    const order = [
      ...jobContacts.filter(c => String(c.type || '').toUpperCase() === 'JOB'),
      ...jobContacts,
      ...companyContacts.filter(c => isOn(c.is_primary_contact)),
      ...companyContacts,
    ];
    const hit = order.find(c => clean(c[field]));
    return hit ? clean(hit[field]) : '';
  };
  const jobNotes = notes
    .map(n => ({ date: noteDate(n), text: clean(n.note) }))
    .filter(n => n.text)
    .sort((a, b) => a.date.localeCompare(b.date));
  const quoteSentDate = dateOf(job.quote_sent_stamp);

  const claims = letteredJobs.filter(l => l.status !== 'Quote').map(l => ({ number: String(l.generated_job_id), status: l.status, date: dateOf(l.date) }));
  const deposits = depositsFrom({ number }, payload.payments);
  const totalIncGst = r2(job.total_invoice_amount);
  const stage = buildJobStage(
    { number, totalIncGst, invoiceSent: isOn(job.invoice_sent) }, claims, payload.materials || [], payload.bundles || [], tierNames,
    new Map(Object.entries(payload.taxRates || {})), deposits,
  );
  const warnings = [...stage.warnings];
  if (!company) warnings.push('ServiceM8 has no client company on this job');

  // The claims the job arrives with. An open job: the Completed claims and the deposits paid, so
  // only the balance is left to invoice. A Completed job was invoiced in full in ServiceM8: its
  // lettered claims, then one claim for whatever is left, so it can never be invoiced again here.
  const dateByNumber = new Map(claims.map(c => [c.number.toLowerCase(), c.date]));
  let quoted = stage.lines.length ? stage.quotedExGst : exGst(totalIncGst);
  // A credit or refund job: the app has no job worth less than nothing, so it comes across at $0
  // with its lines kept.
  if (quoted < 0) { warnings.push(`ServiceM8 has this job at less than $0 ($${quoted.toFixed(2)}): brought across at $0, check it`); quoted = 0; }
  let importedClaims = stage.claimsUsed.filter(c => c.invoiced && c.valueExGst > 0).map(c => ({
    number: c.number, amount: c.valueExGst, date: c.date || dateByNumber.get(String(c.number).toLowerCase()) || null,
    ...(c.paid ? { paid: c.paid, method: c.method, ...(c.amountIncGst ? { amount_inc: c.amountIncGst } : {}), ...(c.payment ? { payment: c.payment } : {}) } : {}),
  }));
  // Claims and deposits can come to more than the job in ServiceM8 (a surcharge, an overpayment, a
  // payment on a job with no value): the ones that fit are kept, the rest are named for checking.
  if (kind === 'job') {
    let running = 0;
    const kept = [];
    for (const c of importedClaims) {
      if (r2(running + c.amount) <= quoted + 0.01) { kept.push(c); running = r2(running + c.amount); }
      else warnings.push(`ServiceM8 has ${c.paid ? 'a payment' : 'a claim'} "${c.number}" of $${c.amount.toFixed(2)} that takes invoiced to date past the job's value ($${quoted.toFixed(2)}): left off, check it`);
    }
    importedClaims = kept;
  }
  let owing = 0;
  if (kind === 'completed') {
    const completedOn = dateOf(job.completion_date) || dateOf(job.date) || null;
    const lettered = stage.claimsUsed.filter(c => c.invoiced && c.valueExGst > 0 && c.status !== 'Paid' && String(c.number) !== number);
    const letteredTotal = r2(lettered.reduce((t, c) => t + c.valueExGst, 0));
    const paidIncGst = r2(deposits.reduce((t, d) => t + d.amountIncGst, 0));
    const last = deposits[deposits.length - 1];
    owing = Math.max(0, r2(totalIncGst - paidIncGst));
    importedClaims = letteredTotal <= quoted + 0.01
      ? lettered.map(c => ({ number: c.number, amount: c.valueExGst, date: dateByNumber.get(String(c.number).toLowerCase()) || null }))
      : [];
    if (letteredTotal > quoted + 0.01) warnings.push(`ServiceM8's claims ($${letteredTotal.toFixed(2)}) come to more than the job ($${quoted.toFixed(2)}): brought across as one claim for the whole job`);
    const balance = r2(quoted - importedClaims.reduce((t, c) => t + c.amount, 0));
    if (balance > 0.005) {
      importedClaims.push({
        number, amount: balance, date: completedOn,
        ...(last && last.date && owing <= 0.01 ? { paid: last.date, method: last.method } : {}),
      });
    }
  }

  return {
    row: {
      sm8JobUuid: job.uuid,
      sm8JobNumber: number,
      kind,
      name: shortTitle(job.job_description),
      description: clean(job.job_description),
      notesText: buildNotesText(job, jobNotes),
      siteAddress: clean(job.job_address) || clean(company && company.address),
      clientEmail: clean(company && company.email) || pick('email'),
      clientPhone: pick('mobile') || pick('phone') || clean(company && company.phone),
      contactName: contactName(jobContacts[0] || companyContacts[0] || {}),
      quoteSent: kind === 'quote' ? (isOn(job.quote_sent) || !!quoteSentDate) : false,
      quoteSentDate,
      sm8Date: dateOf(kind === 'quote' ? job.quote_date : job.work_order_date) || dateOf(job.date),
      completedOn: kind === 'completed' ? (dateOf(job.completion_date) || dateOf(job.date)) : '',
      stage: {
        quotedExGst: quoted,
        invoicedExGst: kind === 'quote' ? 0 : r2(importedClaims.reduce((t, c) => t + c.amount, 0)),
        lines: stage.lines,
        groups: stage.groups,
        claims: kind === 'quote' ? [] : importedClaims,
        stcs: stage.stcs,
      },
    },
    warnings,
    owing,
  };
}

// ---- Line items -----------------------------------------------------------
//
// ServiceM8 keeps a job's billing as jobmaterial rows. A bundle (what the
// app calls a prebuild, e.g. GPO10 x 53) is a jobmaterialbundle record
// with no price of its own; its components are jobmaterial rows pointing
// at it (job_material_bundle_uuid), each already multiplied out for the
// job (26.5 hrs of labour for 53 GPOs at 0.5 hr each) and alternates left
// at quantity 0. Everything else is a standalone row, including the
// negative "Partial invoice #4515A" rows that take each claim off the
// main job. Every row has a unit sell (price) and unit cost, ex GST.

const isPartialInvoice = (m) => /partial\s*invoice/i.test(String(m.name || ''));
const num = (v) => Number(v) || 0;
// "STC Rebate", "BSTC rebate": the customer's STC credit, a negative,
// GST-free line. Not imported as a line item: the import sets them as the
// job's STC and BSTC credits (they come off the invoice) and keeps the list
// in projects.sm8_stcs for the STCs tab (Formbay tracking).
const isStcRebate = (m) => /\bb?stcs?\b/i.test(String(m.name || '')) && num(m.price) * num(m.quantity) < 0;
const stcTypeOf = (name) => (/\bbstc/i.test(name) ? 'bstc' : /\b(swh|hot\s*water)\b/i.test(name) ? 'swh' : 'pv');
const STC_TYPE_LABELS = { pv: 'solar STCs', bstc: 'battery STCs', swh: 'hot water STCs' };

// "160 solar STCs at $35.00 ($5,600.00), 420 battery STCs at $35.00 ($14,700.00)"
function stcsText(stcs) {
  const fmt = (n) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return stcs.map(x => `${x.count} ${STC_TYPE_LABELS[x.type]} at $${fmt(x.price)} ($${fmt(x.total)})`).join(', ');
}

// Labour: a rate tier's name, even with a date on the end ("Licensed
// Electrical Specialist (14/05/2026)"), or an obvious trade/labour word.
function isLabourName(name, tierNames) {
  const n = clean(name).toLowerCase();
  return tierNames.some(t => n.startsWith(t.toLowerCase())) || /\b(labou?r|labou?rer|electrician|apprentice)\b/.test(n);
}

// Builds the one stage an imported job gets: all its prebuilds and line
// items at the full job value, and invoiced to date = the Completed claims.
// job: { number, totalIncGst }, claims: [{ number, status }] from the job list.
// taxRates: Map of ServiceM8 tax_rate_uuid -> rate % (10 for GST, 0 for
// GST-free), used only to check the result against ServiceM8's total.
function buildJobStage(job, claims, jobMaterials, bundles, tierNames, taxRates = new Map(), deposits = []) {
  const warnings = [];
  const active = jobMaterials.filter(m => isOn(m.active));
  const claimStatus = new Map(claims.map(c => [String(c.number).toLowerCase(), c.status]));

  // Claims: value from the main job's partial invoice line.
  const claimsUsed = [];
  for (const m of active.filter(isPartialInvoice)) {
    const value = r2(num(m.price) * -num(m.quantity));
    const number = (clean(m.name).match(/(\d+[a-z]+)\b/i) || [])[1] || '';
    if (!number) { warnings.push(`A partial invoice line has no claim number ("${clean(m.name)}") - check invoiced to date`); }
    const status = claimStatus.get(number.toLowerCase());
    if (!value) continue; // empty claim (e.g. 4515C at $0): nothing taken off the job yet
    if (value < 0) { warnings.push(`Claim #${number || '?'} is a reversal in ServiceM8 ($${value.toFixed(2)}): left out of invoiced to date, check it`); continue; }
    let invoiced = status === 'Completed';
    if (!status) { invoiced = true; warnings.push(`Claim #${number || '?'} not found in ServiceM8 - counted as invoiced, check it`); }
    else if (status === 'Unsuccessful') warnings.push(`Claim #${number} ($${value.toFixed(2)}) is Unsuccessful (voided) in ServiceM8 but still taken off the job there - counted as not invoiced, check it`);
    else if (!invoiced) warnings.push(`Claim #${number} ($${value.toFixed(2)}) is taken off the job in ServiceM8 but is not Completed - counted as not invoiced yet`);
    claimsUsed.push({ number, status: status || 'unknown', valueExGst: value, invoiced });
  }

  // Deposits (payments on the main job: a claim's own payment sits on the claim job) each become
  // a paid claim, so the job comes across with its deposit paid and only the balance left to claim
  // (item 71). The one exception is a job whose own invoice went out with no partial claims: there
  // the payments are that invoice's, and the invoice itself becomes the claim (below, once the
  // job's value is known).
  const invoiceOnly = isOn(job.invoiceSent) && !claimsUsed.length;
  if (!invoiceOnly) {
    for (const d of deposits) claimsUsed.push({ number: d.number, status: 'Paid', valueExGst: d.amount, amountIncGst: d.amountIncGst, invoiced: true, date: d.date, paid: d.date, method: d.method, payment: d.payment });
  }

  // Line items, in ServiceM8's order: each bundle followed by its
  // components, standalone rows in between.
  const bundleByUuid = new Map(bundles.filter(b => isOn(b.active) && num(b.quantity) > 0).map(b => [b.uuid, b]));
  const componentsByBundle = new Map();
  const standalone = [];
  const stcs = [];
  for (const m of active) {
    if (isPartialInvoice(m)) continue;
    if (!m.job_material_bundle_uuid && isStcRebate(m)) {
      const count = Math.abs(num(m.quantity)), price = Math.abs(num(m.price));
      stcs.push({ type: stcTypeOf(clean(m.name)), count, price, total: r2(count * price), label: clean(m.name) });
      continue;
    }
    if (m.job_material_bundle_uuid) {
      if (!bundleByUuid.has(m.job_material_bundle_uuid) || !num(m.quantity)) continue;
      (componentsByBundle.get(m.job_material_bundle_uuid) || componentsByBundle.set(m.job_material_bundle_uuid, []).get(m.job_material_bundle_uuid)).push(m);
    } else if (num(m.quantity)) {
      standalone.push(m);
    }
  }
  const entries = [
    ...[...bundleByUuid.values()].filter(b => componentsByBundle.has(b.uuid)).map(b => ({ sort: num(b.sort_order), bundle: b })),
    ...standalone.map(m => ({ sort: num(m.sort_order), item: m })),
  ].sort((a, b) => a.sort - b.sort);

  const toLine = (m, extra) => ({
    item_type: isLabourName(m.name, tierNames) ? 'labour' : 'material',
    description: clean(m.name) || 'ServiceM8 item',
    quantity: num(m.quantity),
    cost: num(m.cost),
    price: num(m.price),
    sell: r2(num(m.price) * num(m.quantity)),
    ...extra,
  });
  const groups = [];
  const lines = [];
  for (const e of entries) {
    if (e.bundle) {
      const b = e.bundle;
      const key = b.uuid;
      const comps = componentsByBundle.get(key).sort((x, y) => num(x.sort_order) - num(y.sort_order));
      const groupLines = comps.map(m => toLine(m, { group: key, base_quantity: num(m.quantity) / num(b.quantity) }));
      groups.push({ key, code: clean(b.item_number), description: clean(b.name), quantity: num(b.quantity), sell: r2(groupLines.reduce((s, l) => s + l.sell, 0)) });
      lines.push(...groupLines);
    } else {
      lines.push(toLine(e.item, { group: null, base_quantity: null, standalone: true }));
    }
  }

  const quotedExGst = r2(lines.reduce((s, l) => s + l.sell, 0));
  if (invoiceOnly && num(job.totalIncGst) > 0) {
    const paidIncGst = r2(deposits.reduce((s, d) => s + d.amountIncGst, 0));
    const last = deposits[deposits.length - 1];
    claimsUsed.push({
      number: String(job.number), status: 'Completed', valueExGst: lines.length ? quotedExGst : exGst(job.totalIncGst), invoiced: true, date: null,
      paid: last && paidIncGst >= num(job.totalIncGst) - 0.01 ? last.date : null, method: last ? last.method : null,
    });
  }
  const invoicedExGst = r2(claimsUsed.filter(c => c.invoiced).reduce((s, c) => s + c.valueExGst, 0));

  // Check against ServiceM8's own total, which includes GST line by line
  // (STC rebates are GST-free): every active row at its own tax rate
  // should come to the main job's total, give or take rounding.
  const rateOf = (m) => (taxRates.has(m.tax_rate_uuid) ? taxRates.get(m.tax_rate_uuid) : 10);
  const expectedInc = r2(active.reduce((s, m) => s + num(m.price) * num(m.quantity) * (1 + rateOf(m) / 100), 0));
  if (active.length && Math.abs(expectedInc - num(job.totalIncGst)) > 1) {
    warnings.push(`Line items come to $${expectedInc.toFixed(2)} inc GST but ServiceM8's job total is $${num(job.totalIncGst).toFixed(2)} - check the value`);
  }
  if (stcs.length) warnings.push(`STCs set as the job's credits: ${stcsText(stcs)}. Add them on the job's STCs tab after importing to track them with Formbay`);
  if (lines.length) {
    const { markupPercent } = stageFromLines(lines);
    if (markupPercent < 0 || markupPercent > 300) warnings.push(`Materials in ServiceM8 have ${markupPercent < 0 ? 'costs above their sell price' : 'little or no cost recorded'} (stage markup ${Math.round(markupPercent)}%) - profit on this job will look ${markupPercent < 0 ? 'low' : 'high'}`);
  }

  return { lines, groups, claimsUsed, quotedExGst, invoicedExGst, stcs, warnings };
}

// Server side, at import: turns review-screen lines into cost centre line
// items and the stage's figures, the app's way - labour at its sell rate,
// materials at cost with the stage markup on top. The markup is the one
// that makes the materials sell for exactly what ServiceM8 charged, so the
// stage's value matches the job and editing it later does not move it.
// The payments ServiceM8 holds on the main job (jobpayment rows), oldest first, as the paid
// claims they become: "4809 deposit" ($ ex GST, the payment date, the method).
function depositsFrom(job, payments) {
  const rows = (payments || []).filter(p => num(p.amount) > 0)
    .sort((a, b) => String(a.payment_date || a.timestamp || '').localeCompare(String(b.payment_date || b.timestamp || '')));
  return rows.map((p, i) => {
    const date = String(p.payment_date || p.timestamp || '').slice(0, 10);
    return {
      number: `${job.number} deposit${rows.length > 1 ? ' ' + (i + 1) : ''}`,
      payment: p.uuid || null,
      amountIncGst: r2(p.amount),
      amount: exGst(p.amount),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      method: clean(p.payment_method).slice(0, 50) || 'ServiceM8',
    };
  });
}

function stageFromLines(lines) {
  let labourSell = 0, materialCost = 0, materialSell = 0;
  for (const l of lines) {
    if (l.item_type === 'labour') labourSell += l.quantity * l.price;
    else { materialCost += l.quantity * l.cost; materialSell += l.quantity * l.price; }
  }
  // The stage markup column holds up to 9999.99%: past that (a few dollars of cost recorded against
  // thousands of sell) or below -100% the costs are not usable, so the sell price is carried as the cost.
  let costBasis = materialCost > 0.005;
  let markup = 45;
  if (costBasis) markup = Math.round(((materialSell / materialCost) - 1) * 100 * 10000) / 10000;
  if (costBasis && (markup > 9999 || markup < -100)) costBasis = false;
  if (!costBasis) markup = Math.abs(materialSell) > 0.005 ? 0 : 45; // no usable costs in ServiceM8: carry the sell price as the cost
  const items = lines.map(l => ({
    ...l,
    unit_cost: l.item_type === 'labour' ? l.price : (costBasis ? l.cost : l.price),
  }));
  return {
    items,
    markupPercent: markup,
    estimatedLabour: r2(labourSell),
    estimatedMaterial: r2(costBasis ? materialCost : materialSell),
  };
}

module.exports = { stcsText, loadSm8Everything, shapeSm8Job, matchClient, stageFromLines, sm8GetAll, Sm8RateLimit, SM8_BASE, r2 };
