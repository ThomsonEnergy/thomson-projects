// Invoice status in plain words (item 60): the same words on the Invoices page and on the job's
// Invoices tab, worked out from the invoice row, its history (invoice_events, oldest first) and
// its credit notes. Pure: no page, no network. Loaded by invoices.html (a script tag) and
// project.html (loadInvoiceActions, with js/invoice-actions.js).
//   invoiceStatus(inv, { today, balanceDue }) -> { key, label, cls, next, sentAt, reminders, inXero, credited, events, lastEvent }
//     key: not_sent | awaiting | overdue | paid | credited
//   invoiceStatusChipHtml(status)  the coloured badge for the status
//   invoiceEventLabel(kind)        'Emailed to client', 'Pushed to Xero', ...
//   invoiceEventWho(event)         the person's name, or what did it when nobody did
//   invoiceLastActionText(status)  'Reminder sent by Jess, 3 Nov' (the newest history line)
//   invoiceShortDate(iso)          '3 Nov' in Sydney time
// Needs escapeHtml and sydneyDateKey (js/supabase-client.js).

const INVOICE_EVENT_LABELS = {
  created: 'Created',
  edited: 'Edited',
  emailed: 'Emailed to client',
  reminder: 'Reminder sent',
  sent_elsewhere: 'Sent another way',
  pushed_to_xero: 'Pushed to Xero',
  paid: 'Paid',
  credit_note: 'Credit note issued',
  credit_note_pushed: 'Credit note pushed to Xero',
  notes: 'Notes changed',
};
const INVOICE_SENT_KINDS = ['emailed', 'sent_elsewhere'];

function invoiceShortDate(iso) {
  if (!iso) return '';
  // a plain date (due_date) is a Sydney day already; a timestamp is shown in Sydney time
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00+10:00`) : new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });
}

function invoiceEventLabel(kind) { return INVOICE_EVENT_LABELS[kind] || kind; }

function invoiceEventWho(e) {
  if (e.actor && e.actor.full_name) return e.actor.full_name;
  if (e.kind === 'paid') return 'the payment';
  if (e.kind === 'created') return 'the quote approval';
  return '';
}

function invoiceStatus(inv, { today, balanceDue } = {}) {
  const events = (inv.invoice_events || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const todayKey = today || sydneyDateKey(new Date());
  const sent = events.filter(e => INVOICE_SENT_KINDS.includes(e.kind));
  const reminders = events.filter(e => e.kind === 'reminder');
  const inXero = !!inv.xero_invoice_id;
  const creditNotes = inv.credit_notes || [];
  const credited = creditNotes.length > 0;
  const lastEvent = events[events.length - 1] || null;
  const dueKey = inv.due_date || null;
  const overdueDays = dueKey && dueKey < todayKey ? Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dueKey}T00:00:00Z`)) / 86400000) : 0;
  const base = { sentAt: sent.length ? sent[sent.length - 1].created_at : null, reminders, inXero, credited, events, lastEvent };

  if (inv.paid_at) return { ...base, key: 'paid', label: `Paid ${invoiceShortDate(inv.paid_at)}`, cls: 'accepted', next: inXero ? '' : 'Push to Xero' };
  if (credited && balanceDue != null && Number(balanceDue) <= 0.004) return { ...base, key: 'credited', label: 'Credited in full', cls: 'draft', next: '' };
  if (!sent.length) return { ...base, key: 'not_sent', label: 'Not sent', cls: 'amber', next: inXero ? 'Email to client' : 'Email to client, push to Xero' };
  if (overdueDays > 0) {
    const last = reminders[reminders.length - 1];
    const sinceReminder = last ? Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${sydneyDateKey(new Date(last.created_at))}T00:00:00Z`)) / 86400000) : null;
    const next = !last ? 'Send reminder' : sinceReminder >= 7 ? 'Send another reminder' : `Reminder sent ${invoiceShortDate(last.created_at)}, wait`;
    return { ...base, key: 'overdue', label: `Overdue ${overdueDays} day${overdueDays === 1 ? '' : 's'}`, cls: 'red', next: inXero ? next : `${next}, push to Xero` };
  }
  const due = dueKey ? `Due ${invoiceShortDate(dueKey)}` : 'Wait for payment';
  return { ...base, key: 'awaiting', label: 'Sent, awaiting payment', cls: 'info', next: inXero ? due : `Push to Xero. ${due}` };
}

function invoiceStatusChipHtml(status) {
  return `<span class="badge ${status.cls}">${escapeHtml(status.label)}</span>`;
}

function invoiceLastActionText(status) {
  const e = status.lastEvent;
  if (!e) return '';
  const who = invoiceEventWho(e);
  return `${invoiceEventLabel(e.kind)}${who ? ` by ${who}` : ''}, ${invoiceShortDate(e.created_at)}`;
}
