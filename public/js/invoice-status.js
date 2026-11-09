// Invoice status in plain words (item 61): the same words on the Invoices page and on the job's
// Invoices tab, worked out from the invoice row, its history (invoice_events, oldest first) and
// its credit notes. Pure apart from invoiceBalances: no page. Loaded by loadInvoiceActions
// (js/supabase-client.js) on both pages, with js/invoice-actions.js.
//   INVOICE_STATUS_EMBED           the select embed invoiceStatus needs on an invoice row
//   invoiceStatus(inv, { today }) -> { key, label, cls, next, sentAt, needsSending, noSendRecorded, reminders, inXero, credited, events, lastEvent,
//                                     interest: { enabled, accrued, days, daily, isInterestInvoice } } (item 66: the computed
//                                     columns interest_accrued, interest_days, interest_daily on the row)
//     key: not_sent | awaiting | overdue | paid | credited. inv.balance_due (the invoices.balance_due column,
//     inc GST less credit notes) decides Credited in full. needsSending: no email or "sent another way"
//     recorded and money still owed; noSendRecorded: the same on an invoice already overdue.
//   invoiceStatusChipHtml(status)  the coloured badge for the status
//   invoiceEventLabel(kind)        'Emailed to client', 'Pushed to Xero', ...
//   invoiceEventWho(event)         the person's name, or what did it when nobody did
//   invoiceLastActionText(status)  'Reminder sent by Jess, 3 Nov' (the newest history line)
//   invoiceShortDate(iso, { long }) '3 Nov' (or '3 November') in Sydney time; invoiceEventTime(iso) '9:00 am'
// Needs escapeHtml, money and sydneyDateKey (js/supabase-client.js).

const INVOICE_STATUS_EMBED = 'balance_due, interest_enabled, interest_accrued, interest_days, interest_daily, interest_amount, interest_of_invoice_id, credit_notes(id), invoice_events(kind, detail, actor_label, created_at, actor:profiles(full_name))';
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
  interest_on: 'Interest charging turned on',
  interest_off: 'Interest charging turned off',
  interest_charged: 'Interest invoiced',
};
const INVOICE_SENT_KINDS = ['emailed', 'sent_elsewhere'];
// one formatter each: toLocaleDateString with a timeZone builds a new one per call (40x dearer on a long list)
const INVOICE_FMT = {
  short: new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }),
  long: new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', timeZone: 'Australia/Sydney' }),
  time: new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' }),
};

function invoiceShortDate(iso, { long = false } = {}) {
  if (!iso) return '';
  // a plain date (due_date) is a Sydney day already; a timestamp is shown in Sydney time
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00+10:00`) : new Date(iso);
  return (long ? INVOICE_FMT.long : INVOICE_FMT.short).format(d);
}
function invoiceEventTime(iso) { return INVOICE_FMT.time.format(new Date(iso)); }
// whole days from one Sydney date key to another (positive when toKey is later)
const daysBetweenKeys = (fromKey, toKey) => Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);

function invoiceEventLabel(kind) { return INVOICE_EVENT_LABELS[kind] || kind; }

// the person, or what did it when nobody did (actor_label: the quote approval, Xero, the pay online link)
function invoiceEventWho(e) {
  return (e.actor && e.actor.full_name) || e.actor_label || '';
}

function invoiceStatus(inv, { today } = {}) {
  const events = (inv.invoice_events || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const todayKey = today || sydneyDateKey(new Date());
  const sent = events.filter(e => INVOICE_SENT_KINDS.includes(e.kind));
  const reminders = events.filter(e => e.kind === 'reminder');
  const inXero = !!inv.xero_invoice_id;
  const credited = (inv.credit_notes || []).length > 0;
  const lastEvent = events[events.length - 1] || null;
  const dueKey = inv.due_date || null;
  const overdueDays = dueKey && dueKey < todayKey ? daysBetweenKeys(dueKey, todayKey) : 0;
  // unsent: no email or "sent another way" recorded in TEops (the invoice may still have gone out
  // some other way before today's history existed; Sent another way puts that right)
  const settled = !!inv.paid_at || (credited && inv.balance_due != null && Number(inv.balance_due) <= 0.004);
  const interest = {
    enabled: !!inv.interest_enabled, accrued: Number(inv.interest_accrued) || 0, days: Number(inv.interest_days) || 0, daily: Number(inv.interest_daily) || 0,
    isInterestInvoice: !!inv.interest_of_invoice_id || Number(inv.interest_amount) > 0,
  };
  const base = {
    sentAt: sent.length ? sent[sent.length - 1].created_at : null, needsSending: !sent.length && !settled, noSendRecorded: !sent.length && !settled && overdueDays > 0,
    reminders, inXero, credited, events, lastEvent, interest,
  };

  if (inv.paid_at) return { ...base, key: 'paid', label: `Paid ${invoiceShortDate(inv.paid_at)}`, cls: 'accepted', next: inXero ? '' : 'Push to Xero' };
  if (settled) return { ...base, key: 'credited', label: 'Credited in full', cls: 'draft', next: '' };
  // Overdue comes before Not sent: money owed and late is the thing to act on, whether or not a
  // send was recorded (an unsent overdue invoice still offers Send reminder and sits in Needs sending too).
  if (overdueDays > 0) {
    const last = reminders[reminders.length - 1];
    const sinceReminder = last ? daysBetweenKeys(sydneyDateKey(new Date(last.created_at)), todayKey) : null;
    const next = !sent.length ? 'Email to client (no send recorded)' : !last ? 'Send reminder' : sinceReminder >= 7 ? 'Send another reminder' : `Reminder sent ${invoiceShortDate(last.created_at)}, wait`;
    const withInterest = interest.enabled && interest.accrued > 0 ? `${next}, ${money(interest.accrued)} interest accruing` : next;
    return { ...base, key: 'overdue', label: `Overdue ${overdueDays} day${overdueDays === 1 ? '' : 's'}`, cls: 'red', next: inXero ? withInterest : `${withInterest}, push to Xero` };
  }
  if (!sent.length) return { ...base, key: 'not_sent', label: 'Not sent', cls: 'amber', next: inXero ? 'Email to client' : 'Email to client, push to Xero' };
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
