// Read-only ServiceM8 loader for the one-time open-jobs import (Settings >
// ServiceM8 Import). Nothing in here writes to ServiceM8 - it only GETs.
//
// Pulls every active Work Order job plus the companies, contacts and notes
// that go with it, in a handful of bulk calls (ServiceM8's filter only
// does "and", so asking per job would be one call per job per object and
// blow the function's time limit), then shapes each job into the row the
// review screen shows and sm8-import-jobs.js writes.
//
// Money: the app keeps every figure ex GST, ServiceM8's job total includes
// it, so totals are divided by 1.1. Both figures are shown on the review
// screen and the ex GST ones can be edited before importing.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const SM8_BASE = 'https://api.servicem8.com/api_1.0';

async function sm8GetAll(apiKey, object, filter) {
  // ServiceM8 pages large result sets: start with cursor=-1 and follow the
  // x-next-cursor header until it stops coming back. An account small
  // enough to fit in one page just never sends the header.
  const rows = [];
  let cursor = '-1';
  for (let page = 0; page < 50 && cursor; page++) {
    // encodeURIComponent rather than URLSearchParams: the filter's spaces
    // need to go as %20, not +.
    const query = [`cursor=${encodeURIComponent(cursor)}`];
    if (filter) query.push(`%24filter=${encodeURIComponent(filter)}`);
    const url = `${SM8_BASE}/${object}.json?${query.join('&')}`;
    let res;
    // ServiceM8 allows roughly 180 calls a minute; when it says slow down
    // (429), wait a moment and try again rather than failing the job.
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
      if (res.status !== 429) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ServiceM8 ${object} request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (Array.isArray(data)) rows.push(...data);
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

function matchClient(company, contacts, clients) {
  const byUuid = clients.find(c => c.sm8_company_uuid && c.sm8_company_uuid === company.uuid);
  if (byUuid) return { match: { clientId: byUuid.id, reason: 'Linked on a previous import' }, candidates: [byUuid] };

  const name = normName(company.name);
  const emails = new Set([company.email, ...contacts.map(c => c.email)].map(normEmail).filter(Boolean));
  const phones = new Set([company.phone, ...contacts.flatMap(c => [c.phone, c.mobile])].map(normPhone).filter(Boolean));

  const nameHits = name ? clients.filter(c => normName(c.name) === name) : [];
  const emailHits = clients.filter(c => emails.has(normEmail(c.email)));
  const phoneHits = clients.filter(c => phones.has(normPhone(c.phone)));

  // Weaker "did you mean" candidates: one name contains the other.
  const partialHits = name.length >= 4
    ? clients.filter(c => { const n = normName(c.name); return n.length >= 4 && n !== name && (n.includes(name) || name.includes(n)); })
    : [];

  const seen = new Set();
  const candidates = [...nameHits, ...emailHits, ...phoneHits, ...partialHits]
    .filter(c => (seen.has(c.id) ? false : seen.add(c.id)))
    .slice(0, 8);

  let match = null;
  if (nameHits.length === 1) match = { clientId: nameHits[0].id, reason: 'Same name' };
  else if (nameHits.length > 1) {
    const both = nameHits.find(c => emailHits.includes(c) || phoneHits.includes(c));
    match = both
      ? { clientId: both.id, reason: 'Same name and contact details' }
      : { clientId: nameHits[0].id, reason: `Same name (${nameHits.length} clients share it, check this one)`, ambiguous: true };
  } else if (emailHits.length) match = { clientId: emailHits[0].id, reason: 'Same email, different name', ambiguous: true };
  else if (phoneHits.length) match = { clientId: phoneHits[0].id, reason: 'Same phone, different name', ambiguous: true };

  return { match, candidates };
}

// Returns { rows, summary } - one row per open ServiceM8 job, ready for the
// review screen.
async function loadSm8OpenJobs(supabaseAdmin) {
  const apiKey = await getIntegrationKey('servicem8');

  const [workOrders, quoteJobs, companies, companyContacts, jobContacts, notes] = await Promise.all([
    sm8GetAll(apiKey, 'job', "status eq 'Work Order' and active eq 1"),
    sm8GetAll(apiKey, 'job', "status eq 'Quote' and active eq 1"),
    sm8GetAll(apiKey, 'company', 'active eq 1'),
    sm8GetAll(apiKey, 'companycontact', 'active eq 1'),
    sm8GetAll(apiKey, 'jobcontact', 'active eq 1'),
    sm8GetAll(apiKey, 'note', "related_object eq 'job' and active eq 1"),
  ]);

  // Partial invoices: ServiceM8 splits a job into lettered jobs numbered
  // after the main one - 4515 is the job, 4515A the deposit, 4515B progress
  // claim 1 and so on - and takes each one off the main job as a negative
  // "Partial invoice #4515A" line. A Completed claim has been invoiced.
  // Here we only need each claim's status (its value comes from that line
  // on the main job, see buildJobStage). A Completed claim is not in the
  // Work Order list, so fetch every job dated after the day before the
  // oldest open main job ('gt', ServiceM8 has no 'ge').
  const mainJobs = workOrders.filter(j => !claimOf(j));
  const openNumbers = new Set(mainJobs.map(j => String(j.generated_job_id)));
  const dates = mainJobs.map(j => String(j.date || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d > '2000-01-01').sort();
  const since = new Date(new Date(`${dates[0] || '2015-01-02'}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const recentJobs = mainJobs.length ? await sm8GetAll(apiKey, 'job', `active eq 1 and date gt '${since}'`) : [];
  const claimsByNumber = new Map();
  const seenClaims = new Set();
  for (const j of [...workOrders, ...recentJobs]) {
    const claim = claimOf(j);
    if (!claim || seenClaims.has(j.uuid) || !openNumbers.has(claim.base)) continue;
    // Unsuccessful (voided) claims are kept so the review screen can say so;
    // only Completed ones count as invoiced.
    if (j.status === 'Quote') continue;
    seenClaims.add(j.uuid);
    (claimsByNumber.get(claim.base) || claimsByNumber.set(claim.base, []).get(claim.base)).push({
      number: String(j.generated_job_id),
      letter: claim.letter,
      status: j.status,
      description: clean(j.job_description),
      date: String(j.date || '').slice(0, 10),
      total: r2(j.total_invoice_amount),
      totalExGst: exGst(j.total_invoice_amount),
      invoiceSent: isOn(j.invoice_sent),
      paymentAmount: r2(j.payment_amount),
    });
  }
  // Open claims whose main job is not open (finished in ServiceM8, or the
  // claim numbering is off) - listed so they are not silently dropped.
  const orphanClaims = workOrders
    .filter(j => { const c = claimOf(j); return c && !openNumbers.has(c.base); })
    .map(j => String(j.generated_job_id));
  const jobs = mainJobs;

  const [{ data: clients, error: clientsErr }, { data: imported, error: importedErr }] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name, email, phone, address, sm8_company_uuid').limit(10000),
    supabaseAdmin.from('projects').select('id, job_number, sm8_job_uuid').not('sm8_job_uuid', 'is', null),
  ]);
  if (clientsErr) throw clientsErr;
  if (importedErr) throw importedErr;

  const companyByUuid = new Map(companies.map(c => [c.uuid, c]));
  const group = (list, key) => list.reduce((m, x) => { (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x); return m; }, new Map());
  const contactsByCompany = group(companyContacts, 'company_uuid');
  const contactsByJob = group(jobContacts, 'job_uuid');
  const notesByJob = group(notes, 'related_object_uuid');
  const importedByUuid = new Map((imported || []).map(p => [p.sm8_job_uuid, p]));

  const rows = jobs.map(job => {
    const company = companyByUuid.get(job.company_uuid) || { uuid: job.company_uuid || '', name: '' };
    const coContacts = contactsByCompany.get(company.uuid) || [];
    const jContacts = contactsByJob.get(job.uuid) || [];
    const warnings = [];

    // Job contact first (who to call about this job), then the company's
    // primary contact, then anyone at the company.
    const pick = (field) => {
      const order = [
        ...jContacts.filter(c => String(c.type || '').toUpperCase() === 'JOB'),
        ...jContacts,
        ...coContacts.filter(c => isOn(c.is_primary_contact)),
        ...coContacts,
      ];
      const hit = order.find(c => clean(c[field]));
      return hit ? clean(hit[field]) : '';
    };
    const clientEmail = clean(company.email) || pick('email');
    const clientPhone = pick('mobile') || pick('phone') || clean(company.phone);

    let companyName = clean(company.name);
    if (!companyName) {
      companyName = contactName(jContacts[0] || coContacts[0] || {}) || 'Unknown client';
      warnings.push('ServiceM8 has no client company on this job');
    }

    const jobNotes = (notesByJob.get(job.uuid) || [])
      .map(n => ({ date: noteDate(n), text: clean(n.note) }))
      .filter(n => n.text)
      .sort((a, b) => a.date.localeCompare(b.date));

    const sm8Total = r2(job.total_invoice_amount);
    const invoiceSent = isOn(job.invoice_sent);
    const paymentAmount = r2(job.payment_amount);
    const claims = (claimsByNumber.get(String(job.generated_job_id)) || []).sort((a, b) => a.letter.length - b.letter.length || a.letter.localeCompare(b.letter));
    const mainTitle = shortTitle(job.job_description);

    const { match, candidates } = matchClient({ ...company, name: companyName }, [...coContacts, ...jContacts], clients || []);
    if (match?.ambiguous) warnings.push(`Client match needs checking: ${match.reason}`);
    // Name the job after the client as the app already knows them, unless
    // the match is only a guess.
    const matchedName = match && !match.ambiguous ? (candidates.find(c => c.id === match.clientId)?.name || companyName) : companyName;

    const already = importedByUuid.get(job.uuid);

    return {
      sm8JobUuid: job.uuid,
      sm8JobNumber: String(job.generated_job_id || ''),
      sm8Date: String(job.work_order_date || job.date || '').slice(0, 10),
      companyUuid: company.uuid || '',
      companyName,
      companyAddress: clean(company.address || company.billing_address),
      clientEmail,
      clientPhone,
      siteAddress: clean(job.job_address) || clean(company.address),
      description: clean(job.job_description),
      suggestedName: `${matchedName} - ${mainTitle}`,
      sm8Total,
      invoiceSent,
      paymentAmount,
      // Only the claims' status here - the line items step (loadSm8JobLines)
      // works out each claim's value and builds the job's stage.
      claims: claims.map(c => ({ number: c.number, status: c.status, totalExGst: c.totalExGst, date: c.date, paymentAmount: c.paymentAmount })),
      notes: jobNotes,
      notesText: buildNotesText(job, jobNotes),
      clientMatch: match ? { clientId: match.clientId, reason: match.reason, ambiguous: !!match.ambiguous } : null,
      candidates: candidates.map(c => ({ id: c.id, name: c.name, email: c.email || '', phone: c.phone || '', address: c.address || '' })),
      alreadyImported: already ? { projectId: already.id, jobNumber: already.job_number } : null,
      warnings,
    };
  }).sort((a, b) => (Number(a.sm8JobNumber) || 0) - (Number(b.sm8JobNumber) || 0));

  return {
    rows,
    summary: {
      workOrders: rows.length,
      alreadyImported: rows.filter(r => r.alreadyImported).length,
      quotesNotImported: quoteJobs.length,
      claimsFound: seenClaims.size,
      orphanClaims,
    },
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
// GST-free line. In the app that is the stage's STC credit (stc_total),
// taken off each invoice, not a line item.
const isStcRebate = (m) => /\bb?stcs?\b/i.test(String(m.name || '')) && num(m.price) * num(m.quantity) < 0;

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
function buildJobStage(job, claims, jobMaterials, bundles, tierNames, taxRates = new Map()) {
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
    let invoiced = status === 'Completed';
    if (!status) { invoiced = true; warnings.push(`Claim #${number || '?'} not found in ServiceM8 - counted as invoiced, check it`); }
    else if (status === 'Unsuccessful') warnings.push(`Claim #${number} ($${value.toFixed(2)}) is Unsuccessful (voided) in ServiceM8 but still taken off the job there - counted as not invoiced, check it`);
    else if (!invoiced) warnings.push(`Claim #${number} ($${value.toFixed(2)}) is taken off the job in ServiceM8 but is not Completed - counted as not invoiced yet`);
    claimsUsed.push({ number, status: status || 'unknown', valueExGst: value, invoiced });
  }

  // Line items, in ServiceM8's order: each bundle followed by its
  // components, standalone rows in between.
  const bundleByUuid = new Map(bundles.filter(b => isOn(b.active) && num(b.quantity) > 0).map(b => [b.uuid, b]));
  const componentsByBundle = new Map();
  const standalone = [];
  let stcTotal = 0;
  for (const m of active) {
    if (isPartialInvoice(m)) continue;
    if (!m.job_material_bundle_uuid && isStcRebate(m)) { stcTotal += -num(m.price) * num(m.quantity); continue; }
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
  const invoicedExGst = r2(claimsUsed.filter(c => c.invoiced).reduce((s, c) => s + c.valueExGst, 0));
  stcTotal = r2(stcTotal);

  // Check against ServiceM8's own total, which includes GST line by line
  // (STC rebates are GST-free): every active row at its own tax rate
  // should come to the main job's total, give or take rounding.
  const rateOf = (m) => (taxRates.has(m.tax_rate_uuid) ? taxRates.get(m.tax_rate_uuid) : 10);
  const expectedInc = r2(active.reduce((s, m) => s + num(m.price) * num(m.quantity) * (1 + rateOf(m) / 100), 0));
  if (active.length && Math.abs(expectedInc - num(job.totalIncGst)) > 1) {
    warnings.push(`Line items come to $${expectedInc.toFixed(2)} inc GST but ServiceM8's job total is $${num(job.totalIncGst).toFixed(2)} - check the value`);
  }
  if (stcTotal > 0) warnings.push(`STC rebate of $${stcTotal.toFixed(2)} becomes the job's STC credit (taken off its invoices) - check it against any STCs already credited on ServiceM8 claims`);
  if (lines.length) {
    const { markupPercent } = stageFromLines(lines);
    if (markupPercent < 0 || markupPercent > 300) warnings.push(`Materials in ServiceM8 have ${markupPercent < 0 ? 'costs above their sell price' : 'little or no cost recorded'} (stage markup ${Math.round(markupPercent)}%) - profit on this job will look ${markupPercent < 0 ? 'low' : 'high'}`);
  }

  return { lines, groups, claimsUsed, quotedExGst, invoicedExGst, stcTotal, warnings };
}

// Server side, at import: turns review-screen lines into cost centre line
// items and the stage's figures, the app's way - labour at its sell rate,
// materials at cost with the stage markup on top. The markup is the one
// that makes the materials sell for exactly what ServiceM8 charged, so the
// stage's value matches the job and editing it later does not move it.
function stageFromLines(lines) {
  let labourSell = 0, materialCost = 0, materialSell = 0;
  for (const l of lines) {
    if (l.item_type === 'labour') labourSell += l.quantity * l.price;
    else { materialCost += l.quantity * l.cost; materialSell += l.quantity * l.price; }
  }
  const costBasis = materialCost > 0.005;
  let markup = 45;
  if (costBasis) markup = Math.round(((materialSell / materialCost) - 1) * 100 * 10000) / 10000;
  else if (Math.abs(materialSell) > 0.005) markup = 0; // no costs in ServiceM8: carry the sell price as the cost
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

// Line items for a handful of jobs (the review screen asks a few at a
// time, paced to stay under ServiceM8's per-minute limit): two ServiceM8
// calls per job, two jobs at once, plus the tax rates once.
async function loadSm8JobLines(apiKey, jobs, tierNames) {
  const rates = await sm8GetAll(apiKey, 'taxrate');
  // ServiceM8 calls the percentage 'amount' (10 for GST on Income, 0 for GST free).
  const taxRates = new Map(rates.map(t => [t.uuid, num(t.amount)]));
  const out = {};
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        const [mats, bundles] = await Promise.all([
          sm8GetAll(apiKey, 'jobmaterial', `job_uuid eq '${job.uuid}' and active eq 1`),
          sm8GetAll(apiKey, 'jobmaterialbundle', `job_uuid eq '${job.uuid}' and active eq 1`),
        ]);
        out[job.uuid] = { ok: true, ...buildJobStage(job, job.claims || [], mats, bundles, tierNames, taxRates) };
      } catch (err) {
        out[job.uuid] = { ok: false, error: err.message, rateLimited: /\b429\b/.test(err.message) };
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return out;
}

module.exports = { loadSm8OpenJobs, loadSm8JobLines, buildJobStage, stageFromLines, sm8GetAll, SM8_BASE };
