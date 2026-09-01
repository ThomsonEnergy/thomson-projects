// POST /api/push-invoice-to-xero
// Body: { invoiceId }
// Pricing roles only. Copies an already-created, already-sent invoice
// across to Xero as a DRAFT, for the bookkeeper's records - the client
// never sees Xero, they already have the invoice link from the app.
// Handles standalone invoices, legacy single-stage job claims (cost_centre_id
// set directly on the invoice), and multi-stage job claims (project_id set,
// one row per claimed cost centre in invoice_claims) - one Xero line item
// per stage per category (Labour/Materials/STC) for the multi-stage case.
// See update-invoice-in-xero.js for re-sending edits after this.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');
const { buildXeroInvoicePayload } = require('./_shared/build-xero-invoice-payload');

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
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!invoiceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required' }) };
    }

    const { invoice, contactId, reference, lineItems, date, dueDate } = await buildXeroInvoicePayload(supabaseAdmin, invoiceId);
    if (invoice.xero_invoice_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has already been pushed to Xero - use update-invoice-in-xero to push edits instead.' }) };
    }

    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: {
        Invoices: [{
          Type: 'ACCREC',
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Reference: reference,
          InvoiceNumber: invoice.invoice_number,
          Date: date,
          DueDate: dueDate,
          Status: 'DRAFT',
        }],
      },
    });

    const xeroInvoice = result.Invoices[0];
    await supabaseAdmin
      .from('invoices')
      .update({
        xero_invoice_id: xeroInvoice.InvoiceID,
        xero_invoice_status: xeroInvoice.Status,
      })
      .eq('id', invoiceId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceId: xeroInvoice.InvoiceID, invoiceNumber: invoice.invoice_number }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
