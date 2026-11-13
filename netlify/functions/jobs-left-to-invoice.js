// POST /.netlify/functions/jobs-left-to-invoice
// Body: { projectIds: string[] }
// Pricing roles only (it answers in sell prices). Called by public/js/left-to-invoice.js for the
// Jobs list's Left to invoice column and the job page's money strip (backlog item 85).
//
// A do and charge job (proposal_template 'direct_job') has no quoted amount to subtract from, so
// what is left to invoice is the work done and not yet on an invoice, at the price the next
// invoice would carry: labour at each person's sell rate in the Schedule of Rates bands (with the
// job's rate card and the minimum hours a day), materials at cost plus the stage's markup, less a
// commercial agreement's percent off labour. The maths is _shared/job-actuals.js (jobActuals and
// priceActuals), the same copy the do and charge invoice panel and the portal's Work so far read.
// A quoted job is not answered here: its figure is signed minus invoiced, which the page has.
//
// Returns { ok, byProject: { [id]: { leftToInvoice, labour, materials, agreementOff } } } with one
// entry per do and charge job asked for (zeros when nothing is open). Reads only.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { jobActuals, priceActuals } = require('./_shared/job-actuals');

const MAX_JOBS = 200;
const AT_ONCE = 8; // jobs read side by side: each jobActuals is about ten small reads
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

    const { data: jobs, error } = await supabaseAdmin.from('projects').select('id').in('id', projectIds).eq('proposal_template', 'direct_job');
    if (error) throw error;

    const byProject = {};
    const queue = (jobs || []).map((j) => j.id);
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const actuals = await jobActuals(supabaseAdmin, id);
        // a job with no cost centre yet has nothing clocked or received against a stage: nothing to invoice
        const priced = actuals.ok ? priceActuals(actuals.data) : { leftToInvoice: 0, labourOpen: 0, materialsOpen: 0, agreementOff: 0 };
        byProject[id] = { leftToInvoice: priced.leftToInvoice, labour: priced.labourOpen, materials: priced.materialsOpen, agreementOff: priced.agreementOff };
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));

    return { statusCode: 200, body: JSON.stringify({ ok: true, byProject }) };
  } catch (err) {
    console.error('jobs-left-to-invoice error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
