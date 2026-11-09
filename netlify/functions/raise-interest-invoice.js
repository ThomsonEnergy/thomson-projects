// POST /.netlify/functions/raise-interest-invoice
// Body: { invoiceId }
// Late payment interest (item 66). Charges the interest that has accrued on an overdue invoice (its
// "Charge interest" toggle on) as a separate GST free invoice to today, or to the payment date when the
// invoice is already paid. The work is in _shared/interest-invoice.js, shared with the pay online webhook
// (item 68). Pricing roles only. Nothing on the original invoice's amounts changes.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { raiseInterestInvoice, INTEREST_INVOICE_FIELDS } = require('./_shared/interest-invoice');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error) => ({ statusCode: 400, body: JSON.stringify({ ok: false, error }) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!UUID.test(invoiceId || '')) return bad('invoiceId is required');

    const { data: inv, error: invErr } = await supabaseAdmin.from('invoices').select(INTEREST_INVOICE_FIELDS).eq('id', invoiceId).maybeSingle();
    if (invErr) throw invErr;
    if (!inv) return bad('Invoice not found.');
    if (inv.interest_of_invoice_id) return bad('This is already an interest invoice.');
    if (!inv.interest_enabled) return bad('Turn Charge interest on first.');
    if (!inv.project_id) return bad('This invoice has no job.');

    const result = await raiseInterestInvoice(supabaseAdmin, inv, { actorId: user.id });
    if (!result.ok) return bad(result.error);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('raise-interest-invoice error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
