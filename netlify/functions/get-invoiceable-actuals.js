// POST /.netlify/functions/get-invoiceable-actuals
// Body: { projectId }
// Pricing roles only - same audience as raising any invoice. A job with
// no quote behind it (proposal_template 'direct_job', see dashboard.html's
// "+ New job (no quote)") has nothing to claim a % of, so this computes
// what it should actually be invoiced for right now: labour at each
// employee's own sell rate for every hour logged against the job, and
// materials (received POs plus Stock drawn for the job) at cost marked up
// by the cost centre's own markup%, same relationship a quoted stage's
// materials use. Runs server-side so an individual's pay rate never has to
// reach the browser (same reason as compute-labour-cost.js) - only the
// derived sell $ and safe hours total come back.
//
// Worked out per cost centre (a do-and-charge job can be costed to several,
// e.g. a solar disconnect and the reconnect as two site visits): hours go to
// the cost centre they were clocked to, received PO materials to the PO's
// cost centre, and Stock drawn for the job to its job_material_usage cost
// centre. Anything not tied to a cost centre lands on the first one. Stock
// and prebuilds added straight onto an invoice (invoice_line_items) are left
// out of both sides - they were priced and invoiced in one go - so what's
// left to invoice here is only what's accrued outside the invoice builder.
//
// Labour (item 41): each cost centre also gets labourLines, one per clocked
// shift not yet on an invoice (labour line items record the shifts they
// billed in time_entry_ids): who, their rate tier and $/hr, the date, start
// and finish, and the hours split into Schedule of Rates bands
// (_shared/labour-bands.js). The panel builds the rows from these either
// "as per Schedule of Rates" (multipliers, 2 hour minimum) or flat. Materials
// the same way: materialLines, one per PO line received to the job or Stock
// draw not yet on an invoice (job_material_usage), at cost and marked up.
// Rows marked not billable (time_entries.billable, job_material_usage.billable)
// come back flagged so the panel can show them greyed with the tick off.
// The top-level fields are the whole job's totals (with the first cost
// centre's id), which is all the warranty close-out panel needs.
//
// Edit mode (item 64): with invoiceId, the shifts and materials billed on THAT invoice count as not
// yet billed (so they come back as lines, ticked) and the answer carries `invoice`: its claims and
// its line items, so the panel can show the invoice as it is and save into it (update-invoice-lines.js).
// `openInvoices` lists the job's do-and-charge invoices not yet in Xero or paid, so the create panel
// can offer "Add to SI123 instead" of making a second invoice.
//
// The maths lives in _shared/job-actuals.js (the client portal's "Work so far" reads the same copy);
// this function only checks the caller and answers.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { jobActuals } = require('./_shared/job-actuals');

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
    const { projectId, invoiceId } = JSON.parse(event.body || '{}');
    if (!projectId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId is required' }) };
    }
    const result = await jobActuals(supabaseAdmin, projectId, { invoiceId: invoiceId || null });
    if (!result.ok) return { statusCode: 400, body: JSON.stringify({ error: result.error }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result.data }) };
  } catch (err) {
    console.error('get-invoiceable-actuals error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
