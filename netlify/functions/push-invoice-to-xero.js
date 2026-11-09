// POST /api/push-invoice-to-xero
// Body: { invoiceId }
// Pricing roles only. Copies an already-created, already-sent invoice
// across to Xero as AUTHORISED (Xero's "Approved"), for the bookkeeper's
// records - the client never sees Xero, they already have the invoice
// link from the app.
// Handles standalone invoices, legacy single-stage job claims (cost_centre_id
// set directly on the invoice), and multi-stage job claims (project_id set,
// one row per claimed cost centre in invoice_claims) - one Xero line item
// per stage per category (Labour/Materials/STC) for the multi-stage case.
// See update-invoice-in-xero.js for re-sending edits after this.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { pushInvoiceToXero } = require('./_shared/push-invoice-to-xero');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!invoiceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required' }) };
    }

    const { data: existing } = await supabaseAdmin.from('invoices').select('xero_invoice_id').eq('id', invoiceId).maybeSingle();
    if (existing && existing.xero_invoice_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has already been pushed to Xero - use update-invoice-in-xero to push edits instead.' }) };
    }
    const { xeroInvoiceId, invoiceNumber } = await pushInvoiceToXero(supabaseAdmin, invoiceId, { actorId: user.id });
    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceId: xeroInvoiceId, invoiceNumber }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
