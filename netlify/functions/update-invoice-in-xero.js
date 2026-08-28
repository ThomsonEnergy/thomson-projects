// POST /api/update-invoice-in-xero
// Body: { invoiceId }
// Pricing roles only. Re-sends an invoice already pushed to Xero, so an
// edit made here (amounts changed on its claim lines) actually lands in
// Xero too, rather than the two silently drifting apart. Only works while
// the Xero invoice is still DRAFT or SUBMITTED - once it's been approved
// in Xero (or paid), Xero itself won't accept line-item changes, and this
// surfaces that as a normal error rather than silently doing nothing.

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

    const { invoice, contactId, reference, lineItems } = await buildXeroInvoicePayload(supabaseAdmin, invoiceId);
    if (!invoice.xero_invoice_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "This invoice hasn't been pushed to Xero yet - use push-invoice-to-xero instead." }) };
    }

    // Including the existing InvoiceID updates that invoice in place
    // rather than creating a new one - the same endpoint Xero uses for
    // both create and update.
    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: {
        Invoices: [{
          InvoiceID: invoice.xero_invoice_id,
          Type: 'ACCREC',
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Reference: reference,
          InvoiceNumber: invoice.invoice_number,
        }],
      },
    });

    const xeroInvoice = result.Invoices[0];
    await supabaseAdmin
      .from('invoices')
      .update({ xero_invoice_status: xeroInvoice.Status })
      .eq('id', invoiceId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceNumber: invoice.invoice_number, status: xeroInvoice.Status }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
