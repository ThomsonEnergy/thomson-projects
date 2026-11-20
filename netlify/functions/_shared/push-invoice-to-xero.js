// Pushes one TEops invoice to Xero as an AUTHORISED sales invoice and records the Xero id on it, with a
// "pushed to Xero" history line. Shared by push-invoice-to-xero.js (a person presses Push to Xero) and
// airwallex-webhook.js (an interest invoice made by a card payment goes up by itself, item 68).
// Throws when the invoice is already in Xero or Xero refuses; the caller decides what to tell whom.

const { xeroRequest } = require('./xero-client');
const { buildXeroInvoicePayload } = require('./build-xero-invoice-payload');
const { logInvoiceEvent } = require('./invoice-events');
const { allocateForInvoice } = require('./lead-rewards');

async function pushInvoiceToXero(supabaseAdmin, invoiceId, { actorId = null, actorLabel = null } = {}) {
  const { invoice, contactId, reference, lineItems, date, dueDate } = await buildXeroInvoicePayload(supabaseAdmin, invoiceId);
  if (invoice.xero_invoice_id) {
    throw new Error('This invoice has already been pushed to Xero - use update-invoice-in-xero to push edits instead.');
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
        Status: 'AUTHORISED',
      }],
    },
  });
  const xeroInvoice = result.Invoices[0];
  await supabaseAdmin
    .from('invoices')
    .update({ xero_invoice_id: xeroInvoice.InvoiceID, xero_invoice_status: xeroInvoice.Status })
    .eq('id', invoiceId);
  await logInvoiceEvent(supabaseAdmin, { invoiceId, kind: 'pushed_to_xero', actorId, actorLabel, detail: `Approved in Xero as ${invoice.invoice_number}` });
  // a lead reward credit on this invoice is allocated in Xero now the invoice is there (item 74b part 2);
  // never throws, the worker tries again if Xero does not take it
  await allocateForInvoice(supabaseAdmin, invoiceId);
  return { xeroInvoiceId: xeroInvoice.InvoiceID, invoiceNumber: invoice.invoice_number };
}

module.exports = { pushInvoiceToXero };
