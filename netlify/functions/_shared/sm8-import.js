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
    const res = await fetch(`${SM8_BASE}/${object}.json?${query.join('&')}`, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    });
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

  const [jobs, quoteJobs, companies, companyContacts, jobContacts, notes] = await Promise.all([
    sm8GetAll(apiKey, 'job', "status eq 'Work Order' and active eq 1"),
    sm8GetAll(apiKey, 'job', "status eq 'Quote' and active eq 1"),
    sm8GetAll(apiKey, 'company', 'active eq 1'),
    sm8GetAll(apiKey, 'companycontact', 'active eq 1'),
    sm8GetAll(apiKey, 'jobcontact', 'active eq 1'),
    sm8GetAll(apiKey, 'note', "related_object eq 'job' and active eq 1"),
  ]);

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
    const quotedExGst = exGst(sm8Total);
    const invoicedExGst = invoiceSent ? quotedExGst : 0;
    if (!invoiceSent && paymentAmount > 0) warnings.push(`ServiceM8 shows ${paymentAmount.toFixed(2)} paid but no invoice sent - check invoiced to date`);
    if (invoiceSent) warnings.push('ServiceM8 says this job has been invoiced - set invoiced to date to what was actually billed');
    if (!(sm8Total > 0)) warnings.push('No job total in ServiceM8');

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
      suggestedName: `${matchedName} - ${shortTitle(job.job_description)}`,
      sm8Total,
      invoiceSent,
      paymentAmount,
      quotedExGst,
      invoicedExGst,
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
    },
  };
}

module.exports = { loadSm8OpenJobs };
