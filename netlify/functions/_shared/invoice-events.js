// Invoice history (item 60): one line in invoice_events for each thing the server does to an
// invoice, so the Invoices page can show who did what and when. Called by create-invoice.js,
// create-job-from-quote.js (the deposit), send-gmail.js (emailed, reminder), push-invoice-to-xero.js,
// create-credit-note.js, push-credit-note-to-xero.js, xero-webhook.js and airwallex-webhook.js (paid).
// Never throws: a missing history line must not undo the thing that happened. Writes invoice_events.
//
//   logInvoiceEvent(admin, { invoiceId, kind, detail, actorId, emailThreadId })
//   kind: created | edited | emailed | reminder | sent_elsewhere | pushed_to_xero | paid |
//         credit_note | credit_note_pushed | notes (the table's check constraint)

async function logInvoiceEvent(admin, { invoiceId, kind, detail = null, actorId = null, emailThreadId = null }) {
  if (!invoiceId || !kind) return;
  try {
    const { error } = await admin.from('invoice_events').insert({
      invoice_id: invoiceId, kind, detail: detail ? String(detail).slice(0, 500) : null, actor_id: actorId, email_thread_id: emailThreadId,
    });
    if (error) console.error('invoice-events: could not record', kind, 'for', invoiceId, error.message);
  } catch (err) {
    console.error('invoice-events: could not record', kind, 'for', invoiceId, err.message);
  }
}

module.exports = { logInvoiceEvent };
