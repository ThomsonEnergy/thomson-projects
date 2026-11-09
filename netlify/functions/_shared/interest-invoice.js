// Late payment interest invoices (items 66 and 68). One place that turns the interest accrued on an overdue
// invoice (its "Charge interest" toggle on) into a separate invoice for a fixed amount to a stated date:
// GST free (interest_amount, no labour or materials), on the same job, billed to whoever the original bills,
// named "Interest on SI123: N days to d Mon yyyy at R% pa", numbered like any invoice, posting to Xero to
// the Interest charged account (build-xero-invoice-payload.js). The original's accrual restarts the day
// after the charge. Two history lines, three when the new invoice is paid on the spot.
//
//   raiseInterestInvoice(admin, inv, opts)   inv: the original with its interest columns (see FIELDS)
//     opts.actorId / actorLabel   who did it (a person, or 'the pay online link')
//     opts.amount, days, toDate   the charge; default: the invoice's own interest_accrued to today or its payment date
//     opts.paidAt, paidDetail     the new invoice is already paid (a card payment that included the interest)
//   -> { ok: true, invoiceId, invoiceNumber, invoiceToken, amount, days, toDate }
//   -> { ok: false, error } when someone else charged the same days first (the start moved under us)
//
//   interestPaidOnline(admin, invoiceId, paidAmount)   item 68: after a pay online payment, the part of the
//     payment above the balance is the interest; it becomes a paid interest invoice, pushed to Xero when the
//     original is in Xero, so the card settlement matches two Xero invoices. Never throws.

const { computeDueDate } = require('./compute-due-date');
const { logInvoiceEvents, logInvoiceEvent, moneyText } = require('./invoice-events');
const { pushInvoiceToXero } = require('./push-invoice-to-xero');

const FIELDS = 'id, project_id, bill_to_client_id, invoice_number, due_date, paid_at, xero_invoice_id, airwallex_link_amount, interest_enabled, interest_from, interest_of_invoice_id, interest_accrued, interest_days, interest_daily';
const r2 = (n) => Math.round(n * 100) / 100;
const sydneyDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const longDate = (key) => new Date(`${key}T12:00:00+10:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function raiseInterestInvoice(supabaseAdmin, inv, { actorId = null, actorLabel = null, amount, days, toDate, paidAt = null, paidDetail = null } = {}) {
  amount = r2(amount != null ? Number(amount) : Number(inv.interest_accrued) || 0);
  days = days != null ? Number(days) : Number(inv.interest_days) || 0;
  toDate = toDate || (inv.paid_at ? sydneyDay(inv.paid_at) : sydneyDay(new Date()));
  if (amount < 0.01 || days < 1) return { ok: false, error: 'No interest has accrued yet.' };

  const [{ data: settings }, { data: project }] = await Promise.all([
    supabaseAdmin.from('company_settings').select('invoice_number_prefix, late_interest_rate_pct').eq('id', 1).single(),
    supabaseAdmin.from('projects').select('client_id').eq('id', inv.project_id).single(),
  ]);
  const rate = Number(settings?.late_interest_rate_pct) || 21;
  const description = `Interest on ${inv.invoice_number}: ${days} day${days === 1 ? '' : 's'} to ${longDate(toDate)} at ${rate}% pa`.slice(0, 200);

  const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
  if (numErr) throw numErr;
  const invoiceNumber = `${settings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
  const { data: client } = project?.client_id
    ? await supabaseAdmin.from('clients').select('payment_terms').eq('id', project.client_id).maybeSingle()
    : { data: null };
  const now = new Date().toISOString();
  const dueDate = computeDueDate(client?.payment_terms || 'cod', sydneyDay(now));

  // The original's accrual restarts the day after this charge. Moved first, and only from the start this
  // request read, so two people pressing Raise together cannot both charge the same days.
  const periodStart = inv.interest_from || addDays(inv.due_date, 1);
  let moveFrom = supabaseAdmin.from('invoices').update({ interest_from: addDays(toDate, 1) }).eq('id', inv.id);
  moveFrom = inv.interest_from ? moveFrom.eq('interest_from', inv.interest_from) : moveFrom.is('interest_from', null);
  const { data: moved, error: fromErr } = await moveFrom.select('id');
  if (fromErr) throw fromErr;
  if (!(moved || []).length) return { ok: false, error: 'Interest on this invoice was just charged by someone else. Close and reopen the invoice.' };

  // the interest invoice bills whoever the original bills (a warranty job bills the manufacturer) and
  // records the first day it covers in interest_from
  const { data: made, error: insErr } = await supabaseAdmin
    .from('invoices')
    .insert({
      project_id: inv.project_id, cost_centre_id: null, client_id: null, bill_to_client_id: inv.bill_to_client_id || null,
      description, invoice_number: invoiceNumber,
      labour_amount: 0, material_amount: 0, stc_amount: 0, bstc_amount: 0, claim_percent: null,
      interest_amount: amount, interest_of_invoice_id: inv.id, interest_from: periodStart, show_quote_lines: false,
      sent_at: now, due_date: dueDate, created_by: actorId, paid_at: paidAt,
    })
    .select('id, invoice_token')
    .single();
  if (insErr) {
    // nothing was charged: give the original its days back
    await supabaseAdmin.from('invoices').update({ interest_from: inv.interest_from }).eq('id', inv.id);
    throw insErr;
  }

  const who = { actorId, actorLabel };
  const events = [
    { invoiceId: inv.id, kind: 'interest_charged', ...who, detail: `${moneyText(amount)} for ${days} day${days === 1 ? '' : 's'} to ${longDate(toDate)}, invoiced as ${invoiceNumber}` },
    { invoiceId: made.id, kind: 'created', ...who, detail: `${description} (GST free)` },
  ];
  if (paidAt) events.push({ invoiceId: made.id, kind: 'paid', ...who, detail: paidDetail || 'Paid' });
  await logInvoiceEvents(supabaseAdmin, events);

  return { ok: true, invoiceId: made.id, invoiceNumber, invoiceToken: made.invoice_token, amount, days, toDate };
}

async function interestPaidOnline(supabaseAdmin, invoiceId, paidAmount) {
  try {
    const { data: inv, error } = await supabaseAdmin.from('invoices').select(FIELDS).eq('id', invoiceId).maybeSingle();
    if (error) throw error;
    if (!inv || !inv.interest_enabled || inv.interest_of_invoice_id || !inv.project_id || !inv.paid_at) return null;
    const { data: balance, error: balErr } = await supabaseAdmin.rpc('get_invoice_balance_due', { p_invoice_id: inv.id });
    if (balErr) throw balErr;
    const paid = Number(paidAmount) || Number(inv.airwallex_link_amount) || 0;
    const portion = r2(paid - Number(balance));
    if (portion < 0.01) return null;
    // the days the client paid for: the link was made for the interest to its day, so the daily figure gives them back
    const daily = Number(inv.interest_daily) || 0;
    const days = daily > 0 ? Math.max(1, Math.round(portion / daily)) : Math.max(1, Number(inv.interest_days) || 1);
    const result = await raiseInterestInvoice(supabaseAdmin, inv, {
      actorLabel: 'the pay online link', amount: portion, days, toDate: sydneyDay(inv.paid_at),
      paidAt: inv.paid_at, paidDetail: `Paid by card with ${inv.invoice_number} through the pay online link`,
    });
    if (!result.ok) { console.error('interestPaidOnline:', result.error); return null; }
    if (inv.xero_invoice_id) {
      // the original is in Xero, so the interest goes up too and the card settlement matches both
      try {
        await pushInvoiceToXero(supabaseAdmin, result.invoiceId, { actorLabel: 'the pay online link' });
      } catch (err) {
        console.error(`interestPaidOnline: ${result.invoiceNumber} not pushed to Xero: ${err.message}`);
        await logInvoiceEvent(supabaseAdmin, { invoiceId: result.invoiceId, kind: 'notes', actorLabel: 'the pay online link', detail: `Not pushed to Xero: ${String(err.message).slice(0, 200)}. Press Push to Xero.` });
      }
    }
    return result;
  } catch (err) {
    console.error('interestPaidOnline error:', err.message);
    return null;
  }
}

module.exports = { raiseInterestInvoice, interestPaidOnline, INTEREST_INVOICE_FIELDS: FIELDS };
