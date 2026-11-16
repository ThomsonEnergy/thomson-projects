// Sends an invoice's details to the Xero invoice it was pushed as (owner, 16 Nov 2026): the date, due
// date, reference and contact (who it is billed to), and the wording of its lines when that changed (a stage renamed, the invoice's
// name on a one-line invoice). Amounts are never sent differently: the lines go back with Xero's own
// quantities, prices, accounts and tax, so a change of money still goes through a credit note.
// Used by update-invoice-details.js (Edit details, and Resend to Xero when an update did not go).
//
//   xeroInvoiceBlocker(xeroInvoice)       why Xero will not take changes ('' when it will)
//   readXeroInvoice(xeroInvoiceId)        the invoice as Xero has it now
//   updateInvoiceInXero(admin, invoiceId) sends the details; throws with Xero's reason when refused

const { xeroRequest } = require('./xero-client');
const { buildXeroInvoicePayload } = require('./build-xero-invoice-payload');
const { moneyText } = require('./invoice-events');

async function readXeroInvoice(xeroInvoiceId) {
  const res = await xeroRequest('accounting', `Invoices/${encodeURIComponent(xeroInvoiceId)}`);
  return (res && res.Invoices && res.Invoices[0]) || null;
}

function xeroInvoiceBlocker(x) {
  if (!x) return 'Xero could not find this invoice.';
  if (x.Status === 'VOIDED' || x.Status === 'DELETED') return `It is ${x.Status.toLowerCase()} in Xero.`;
  if (x.Status === 'PAID' || Number(x.AmountPaid) > 0) return `Xero shows ${moneyText(x.AmountPaid)} paid on it, and Xero does not take changes to an invoice with a payment. Use a credit note.`;
  return '';
}

// Xero's lines with our wording, when they are still the lines we pushed (same count, same prices
// and accounts, in the same order) and some wording differs; otherwise null and the lines are left
// alone (someone changed them in Xero, or a credit note is allocated against them).
function reworded(theirs, ours, current) {
  if (!Array.isArray(theirs) || theirs.length !== ours.length || Number(current.AmountCredited) > 0) return null;
  const same = theirs.every((l, i) => Math.abs(Number(l.UnitAmount) - Number(ours[i].UnitAmount)) < 0.005 && String(l.AccountCode) === String(ours[i].AccountCode));
  if (!same || theirs.every((l, i) => l.Description === ours[i].Description)) return null;
  return theirs.map((l, i) => {
    const line = { LineItemID: l.LineItemID, Description: ours[i].Description, Quantity: l.Quantity, UnitAmount: l.UnitAmount, AccountCode: l.AccountCode, TaxType: l.TaxType };
    if (l.ItemCode) line.ItemCode = l.ItemCode;
    if (l.DiscountRate) line.DiscountRate = l.DiscountRate;
    if (Array.isArray(l.Tracking) && l.Tracking.length) line.Tracking = l.Tracking;
    return line;
  });
}

async function updateInvoiceInXero(admin, invoiceId) {
  const { invoice, contactId, reference, lineItems, date, dueDate } = await buildXeroInvoicePayload(admin, invoiceId);
  if (!invoice.xero_invoice_id) throw new Error('This invoice is not in Xero yet. Use Push to Xero.');
  const current = await readXeroInvoice(invoice.xero_invoice_id);
  const blocker = xeroInvoiceBlocker(current);
  if (blocker) throw new Error(blocker);
  const body = { InvoiceID: invoice.xero_invoice_id, Reference: reference, Date: date, DueDate: dueDate };
  // billed to someone else now (Edit details > Bill to): the Xero invoice moves to that contact
  if (contactId && (!current.Contact || current.Contact.ContactID !== contactId)) body.Contact = { ContactID: contactId };
  const lines = reworded(current.LineItems, lineItems, current);
  if (lines) { body.LineItems = lines; body.LineAmountTypes = current.LineAmountTypes; }
  const res = await xeroRequest('accounting', 'Invoices', { method: 'POST', body: { Invoices: [body] } });
  const saved = res && res.Invoices && res.Invoices[0];
  if (saved && saved.Status) await admin.from('invoices').update({ xero_invoice_status: saved.Status }).eq('id', invoiceId);
  return { linesReworded: !!lines };
}

module.exports = { updateInvoiceInXero, readXeroInvoice, xeroInvoiceBlocker };
