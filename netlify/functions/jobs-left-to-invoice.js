// POST /.netlify/functions/jobs-left-to-invoice
// Body: { projectIds: string[] }
// Pricing roles only (it answers in sell prices). Called by public/js/left-to-invoice.js for the
// Jobs list's Left to invoice column and the job page's money strip (backlog item 85).
//
// A do and charge job (proposal_template 'direct_job') has no quoted amount to subtract from, so
// what is left to invoice is the work done and not yet on an invoice, at the price the next
// invoice would carry: labour at each person's sell rate in the Schedule of Rates bands (with the
// job's rate card and the minimum hours a day), materials at cost plus the stage's markup, less a
// commercial agreement's percent off labour, less anything the job was invoiced as a plain amount
// (a ServiceM8 import's invoices, materials billed in Bulk). The maths is _shared/job-actuals.js
// (jobActuals and priceActuals), the same copy the do and charge invoice panel and the portal's
// Work so far read. A quoted job is not answered here: its figure is signed minus invoiced, which
// the page has. A warranty job answers zero: it is made as a do and charge job, but it is billed,
// if at all, by its close-out (Absorbed, Manufacturer, Client), never as do and charge work.
//
// Returns { ok, byProject: { [id]: { leftToInvoice, labour, materials, agreementOff, lumpInvoiced } } }
// with one entry per do and charge job asked for (zeros when nothing is open). A failed read fails
// the whole call (500): a money figure is never guessed. Reads only.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { jobActuals, priceActuals, loadActualsShared } = require('./_shared/job-actuals');

const MAX_JOBS = 200;
const AT_ONCE = 8; // jobs read side by side: each jobActuals is about seven small reads
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { projectIds } = JSON.parse(event.body || '{}');
    if (!Array.isArray(projectIds) || !projectIds.length || projectIds.length > MAX_JOBS || !projectIds.every((id) => UUID.test(String(id)))) {
      return { statusCode: 400, body: JSON.stringify({ error: `projectIds (1 to ${MAX_JOBS} job ids) is required` }) };
    }

    const { data: jobs, error } = await supabaseAdmin.from('projects').select('id, warranty_of_project_id').in('id', projectIds).eq('proposal_template', 'direct_job');
    if (error) throw error;

    const NOTHING = { leftToInvoice: 0, labour: 0, materials: 0, agreementOff: 0, lumpInvoiced: 0 };
    const byProject = {};
    (jobs || []).filter((j) => j.warranty_of_project_id).forEach((j) => { byProject[j.id] = { ...NOTHING }; });
    const queue = (jobs || []).filter((j) => !j.warranty_of_project_id).map((j) => j.id);
    const shared = queue.length ? await loadActualsShared(supabaseAdmin) : null; // read once, not once per job
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const actuals = await jobActuals(supabaseAdmin, id, { shared });
        // a job with no cost centre yet has nothing clocked or received against a stage: nothing to invoice
        if (!actuals.ok) { byProject[id] = { ...NOTHING }; continue; }
        const priced = priceActuals(actuals.data);
        byProject[id] = { leftToInvoice: priced.leftToInvoice, labour: priced.labourOpen, materials: priced.materialsOpen, agreementOff: priced.agreementOff, lumpInvoiced: priced.lumpInvoiced };
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));

    return { statusCode: 200, body: JSON.stringify({ ok: true, byProject }) };
  } catch (err) {
    console.error('jobs-left-to-invoice error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
