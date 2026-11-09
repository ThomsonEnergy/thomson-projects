// Invoice history (item 61): one line in invoice_events for each thing the server does to an
// invoice, so the Invoices page can show who did what and when. Called by create-invoice.js,
// create-job-from-quote.js (the deposit), send-gmail.js (emailed, reminder), push-invoice-to-xero.js,
// create-credit-note.js, push-credit-note-to-xero.js, xero-webhook.js and airwallex-webhook.js (paid).
// Never throws: a missing history line must not undo the thing that happened. Writes invoice_events.
//
//   logInvoiceEvent(admin, { invoiceId, kind, detail, actorId, actorLabel, emailThreadId })
//   logInvoiceEvents(admin, [rows])   several lines in one write
//   moneyText(n)                      '$1,234.50', the way the app prints money, for detail text
//   kind: created | edited | emailed | reminder | sent_elsewhere | pushed_to_xero | paid |
//         credit_note | credit_note_pushed | notes | interest_on | interest_off | interest_charged
//         (the table's check constraint)
//   actorLabel: what did it when nobody did ('the quote approval', 'Xero', 'the pay online link')
// A database trigger copies every line to the job's Activity tab (activity_log), so nothing here
// writes that table.

const moneyText = (n) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function logInvoiceEvents(admin, rows) {
  const list = (rows || []).filter(r => r && r.invoiceId && r.kind).map(r => ({
    invoice_id: r.invoiceId, kind: r.kind, detail: r.detail ? String(r.detail).slice(0, 500) : null,
    actor_id: r.actorId || null, actor_label: r.actorLabel || null, email_thread_id: r.emailThreadId || null,
  }));
  if (!list.length) return;
  try {
    const { error } = await admin.from('invoice_events').insert(list);
    if (error) console.error('invoice-events: could not record', list.map(r => r.kind).join(', '), 'for', list[0].invoice_id, error.message);
  } catch (err) {
    console.error('invoice-events: could not record', list.map(r => r.kind).join(', '), 'for', list[0].invoice_id, err.message);
  }
}
const logInvoiceEvent = (admin, row) => logInvoiceEvents(admin, [row]);

module.exports = { logInvoiceEvent, logInvoiceEvents, moneyText };
