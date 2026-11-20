// Pushes one TEops invoice to Xero as an AUTHORISED sales invoice and records the Xero id on it, with a
// "pushed to Xero" history line. Shared by push-invoice-to-xero.js (a person presses Push to Xero),
// airwallex-webhook.js (an interest invoice made by a card payment goes up by itself, item 68) and
// send-gmail.js (an invoice goes up by itself once it is emailed to the client: startPushWhenEmailed,
// done by push-emailed-invoice-background.js through pushWhenEmailed).
// pushInvoiceToXero throws when the invoice is already in Xero or Xero refuses; the caller decides what
// to tell whom. Writes invoices.xero_invoice_id and xero_invoice_status, and invoice_events.

const fetch = require('node-fetch');
const { selfBaseUrl } = require('./site-url');
const { internalHeaders } = require('./require-internal');
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

// An invoice the client has been emailed goes to Xero by itself (owner, 20 Nov 2026: "as soon as invoice
// is emailed to client push it to Xero"), so nobody has to remember Push to Xero, and a lead reward credit
// on it is allocated straight away. Nothing happens when it is already there. Never throws: the email
// has gone. What Xero refuses goes in the invoice's history, and Push to Xero on the invoice still works.
async function pushWhenEmailed(supabaseAdmin, invoiceId) {
  try {
    const { data: inv } = await supabaseAdmin.from('invoices').select('xero_invoice_id').eq('id', invoiceId).maybeSingle();
    if (!inv || inv.xero_invoice_id) return { pushed: false };
    await pushInvoiceToXero(supabaseAdmin, invoiceId, { actorLabel: 'the invoice email' });
    return { pushed: true };
  } catch (err) {
    console.error('pushWhenEmailed:', invoiceId, err.message);
    await logInvoiceEvent(supabaseAdmin, { invoiceId, kind: 'notes', actorLabel: 'the invoice email', detail: `Not pushed to Xero: ${String(err.message).slice(0, 200)}. Press Push to Xero.` });
    return { pushed: false, error: err.message };
  }
}

// Starts that push without making the email wait for Xero (push-emailed-invoice-background.js does it).
// Never throws.
async function startPushWhenEmailed(invoiceId) {
  try {
    await fetch(`${selfBaseUrl()}/.netlify/functions/push-emailed-invoice-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ invoiceId }),
    });
  } catch (err) {
    console.error('Could not start the push to Xero for an emailed invoice:', invoiceId, err.message);
  }
}

module.exports = { pushInvoiceToXero, pushWhenEmailed, startPushWhenEmailed };
