// POST /.netlify/functions/raise-interest-invoice
// Body: { invoiceId }
// Late payment interest (item 66). Charges the interest that has accrued on an overdue invoice (its
// "Charge interest" toggle on) as a separate invoice for a fixed amount to a stated date: the invoice's
// own interest_accrued (the one rule, a computed column), to today or to the payment date when the
// invoice is already paid. The new invoice is GST free (interest_amount, no labour or materials), on the
// same job, named "Interest on SI123: N days to d Mon yyyy at R% pa", numbered like any invoice, and
// posts to Xero to the Interest charged account (build-xero-invoice-payload.js). The original's accrual
// then restarts the day after the charge, so a later top-up covers only new days. Two history lines.
// Pricing roles only. Nothing on the original invoice's amounts changes.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { computeDueDate } = require('./_shared/compute-due-date');
const { logInvoiceEvents, moneyText } = require('./_shared/invoice-events');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error) => ({ statusCode: 400, body: JSON.stringify({ ok: false, error }) });
const sydneyDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const longDate = (key) => new Date(`${key}T12:00:00+10:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!UUID.test(invoiceId || '')) return bad('invoiceId is required');

    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, project_id, invoice_number, due_date, paid_at, interest_enabled, interest_from, interest_of_invoice_id, interest_accrued, interest_days, interest_daily')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!inv) return bad('Invoice not found.');
    if (inv.interest_of_invoice_id) return bad('This is already an interest invoice.');
    if (!inv.interest_enabled) return bad('Turn Charge interest on first.');
    if (!inv.project_id) return bad('This invoice has no job.');
    const amount = Math.round((Number(inv.interest_accrued) || 0) * 100) / 100;
    const days = Number(inv.interest_days) || 0;
    if (amount < 0.01 || days < 1) return bad('No interest has accrued yet.');

    const [{ data: settings }, { data: project }] = await Promise.all([
      supabaseAdmin.from('company_settings').select('invoice_number_prefix, late_interest_rate_pct').eq('id', 1).single(),
      supabaseAdmin.from('projects').select('client_id').eq('id', inv.project_id).single(),
    ]);
    const rate = Number(settings?.late_interest_rate_pct) || 21;
    // to the payment date when paid, else today (the same end the computed columns use)
    const toDate = inv.paid_at ? sydneyDay(inv.paid_at) : sydneyDay(new Date());
    const description = `Interest on ${inv.invoice_number}: ${days} day${days === 1 ? '' : 's'} to ${longDate(toDate)} at ${rate}% pa`.slice(0, 200);

    const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
    if (numErr) throw numErr;
    const invoiceNumber = `${settings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
    const { data: client } = project?.client_id
      ? await supabaseAdmin.from('clients').select('payment_terms').eq('id', project.client_id).maybeSingle()
      : { data: null };
    const now = new Date().toISOString();
    const dueDate = computeDueDate(client?.payment_terms || 'cod', sydneyDay(now));

    const { data: made, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert({
        project_id: inv.project_id, cost_centre_id: null, client_id: null,
        description, invoice_number: invoiceNumber,
        labour_amount: 0, material_amount: 0, stc_amount: 0, bstc_amount: 0, claim_percent: null,
        interest_amount: amount, interest_of_invoice_id: inv.id,
        sent_at: now, due_date: dueDate, created_by: user.id,
      })
      .select('id, invoice_token')
      .single();
    if (insErr) throw insErr;

    // the original's accrual restarts the day after this charge
    const { error: fromErr } = await supabaseAdmin.from('invoices').update({ interest_from: addDays(toDate, 1) }).eq('id', inv.id);
    if (fromErr) throw fromErr;

    await logInvoiceEvents(supabaseAdmin, [
      { invoiceId: inv.id, kind: 'interest_charged', actorId: user.id, detail: `${moneyText(amount)} for ${days} day${days === 1 ? '' : 's'} to ${longDate(toDate)}, invoiced as ${invoiceNumber}` },
      { invoiceId: made.id, kind: 'created', actorId: user.id, detail: `${description} (GST free)` },
    ]);

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceId: made.id, invoiceNumber, invoiceToken: made.invoice_token, amount, days, toDate }) };
  } catch (err) {
    console.error('raise-interest-invoice error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
