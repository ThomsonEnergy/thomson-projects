// Supplier payments (docs/PO_REVIEW.md Delivery 1). Admin / Finance only.
//
// GET  /.netlify/functions/run-supplier-payments
//      Approved, unpaid bills whose pay-on date (supplier_bills.pay_on: the later of the supplier's
//      terms date and the day we approved) is today in Sydney or earlier, grouped by supplier.
// POST { action: 'mark_paid', bill_ids, paid_on, reference }
//      Records those bills as paid: one supplier_payments row per supplier (the batch), each bill
//      gets paid, paid_at, paid_by, payment_id and the reference. Refuses a bill that is not approved.
//      A credit note (kind credit_note, a negative amount, item 82) nets against the supplier's bills in the
//      batch; a supplier whose net is below zero is refused by the database ("credit bigger than the bills").
//      One database step (supplier_bills_mark_paid): the bills are locked, checked and marked with
//      their batch rows all or nothing, so two presses within seconds cannot record them twice.
// POST { action: 'mark_paid_any', bill_id, paid_on, method, reference }
//      Also "Refunded" on a credit note (method 'refund'): the money came back instead of netting off a bill.
//      A bill paid before approval (card at the counter, paid upfront; item 51): approved by the
//      person pressing the button and marked paid in one database step
//      (supplier_bills_approve_and_mark_paid), method card / cash / bank_transfer / airwallex.
// POST { action: 'undo_paid', bill_id, note }
//      Takes a bill back to unpaid (wrong tick) and reduces its batch row (the last bill of a batch
//      removes the batch row: the status list has no 'reversed').
//
// Sending the money is still done in Airwallex or by bank transfer by hand. Airwallex payouts need a
// payout-enabled API key, a beneficiary per supplier and the accountant's sign-off (backlog item 1);
// when that is built it will create the transfers from the same batch and then call mark_paid.

const { requireFinanceRole } = require('./_shared/require-finance-role');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const PAID_METHODS = ['card', 'cash', 'bank_transfer', 'airwallex', 'refund', 'other']; // refund: a credit note's money came back (item 82)
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

exports.handler = async (event) => {
  const auth = await requireFinanceRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  const log = (supplierId, action, description) => admin.from('activity_log').insert({ entity_type: 'supplier', entity_id: supplierId, action, description, changed_by: user.id });

  try {
    if (event.httpMethod === 'GET') {
      const today = sydneyToday();
      const { data: bills, error } = await admin
        .from('supplier_bills')
        .select('id, bill_number, amount, kind, supplier_id, pay_on, due_date, suppliers(name, bank_account_number, bsb, bpay_biller_code)')
        .eq('paid', false)
        .eq('approved_for_payment', true)
        .not('supplier_id', 'is', null)
        .or(`pay_on.lte.${today},and(pay_on.is.null,due_date.lte.${today})`)
        .order('pay_on');
      if (error) throw error;

      const bySupplier = {};
      (bills || []).forEach(b => {
        const sid = b.supplier_id;
        if (!bySupplier[sid]) {
          bySupplier[sid] = {
            supplierId: sid, supplierName: b.suppliers?.name || 'Unknown', billCount: 0, total: 0, bills: [],
            hasBankDetails: !!(b.suppliers?.bank_account_number || b.suppliers?.bpay_biller_code),
          };
        }
        bySupplier[sid].billCount += 1;
        bySupplier[sid].total += Number(b.amount) || 0;
        bySupplier[sid].bills.push({ id: b.id, billNumber: b.bill_number, amount: Number(b.amount) || 0, kind: b.kind || 'bill', payOn: b.pay_on || b.due_date });
      });
      // credit notes are minus rows (item 82): the supplier's total is the net; below zero there is nothing to pay yet
      const preview = Object.values(bySupplier).map(p => ({ ...p, total: Math.round(p.total * 100) / 100, creditInHand: p.total < -0.005 }));
      return json(200, { ok: true, today, preview });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'mark_paid') {
      const ids = Array.isArray(body.bill_ids) ? body.bill_ids.filter(Boolean) : [];
      if (!ids.length) return json(400, { ok: false, error: 'Pick at least one bill.' });
      const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(body.paid_on || '') ? body.paid_on : sydneyToday();
      const reference = String(body.reference || '').trim().slice(0, 120) || null;
      // the database function locks the bills, refuses one that is not approved, already paid or without a
      // supplier, then writes the batch rows, marks the bills and logs it in one transaction. It raises
      // (code P0001) with a plain message when something is wrong, and returns one row per supplier.
      const { data: paid, error } = await admin.rpc('supplier_bills_mark_paid', { p_bill_ids: ids, p_paid_on: paidOn, p_reference: reference, p_user: user.id });
      if (error && error.code === 'P0001') return json(400, { ok: false, error: error.message });
      if (error) throw error;
      const results = (paid || []).map(r => ({ supplierId: r.supplier_id, supplier: r.supplier || 'Supplier', amount: Number(r.amount) || 0, billCount: Number(r.bill_count) || 0 }));
      return json(200, { ok: true, results });
    }

    if (body.action === 'mark_paid_any') {
      if (!body.bill_id) return json(400, { ok: false, error: 'bill_id is required' });
      const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(body.paid_on || '') ? body.paid_on : sydneyToday();
      const method = PAID_METHODS.includes(body.method) ? body.method : null;
      const reference = String(body.reference || '').trim().slice(0, 120) || null;
      const { data: paid, error } = await admin.rpc('supplier_bills_approve_and_mark_paid', { p_bill_id: body.bill_id, p_paid_on: paidOn, p_reference: reference, p_user: user.id, p_method: method });
      if (error && error.code === 'P0001') return json(400, { ok: false, error: error.message });
      if (error) throw error;
      return json(200, { ok: true, results: paid || [] });
    }

    if (body.action === 'undo_paid') {
      if (!body.bill_id) return json(400, { ok: false, error: 'bill_id is required' });
      const { data: bill } = await admin.from('supplier_bills').select('id, bill_number, amount, supplier_id, paid, payment_id').eq('id', body.bill_id).maybeSingle();
      if (!bill) return json(404, { ok: false, error: 'That bill was not found.' });
      if (!bill.paid) return json(400, { ok: false, error: 'That bill is not marked paid.' });
      const { error: upErr } = await admin.from('supplier_bills')
        .update({ paid: false, paid_at: null, paid_by: null, payment_id: null, payment_reference: null }).eq('id', bill.id);
      if (upErr) throw upErr;
      if (bill.payment_id) {
        // the batch row follows the bills still on it: their total and count, or gone when this was the last one
        const { data: left, error: leftErr } = await admin.from('supplier_bills').select('amount').eq('payment_id', bill.payment_id).eq('paid', true);
        if (leftErr) throw leftErr;
        const total = Math.round((left || []).reduce((s, b) => s + (Number(b.amount) || 0), 0) * 100) / 100;
        const { error: batchErr } = (left || []).length
          ? await admin.from('supplier_payments').update({ total_amount: total, bill_count: left.length, status: 'paid' }).eq('id', bill.payment_id)
          : await admin.from('supplier_payments').delete().eq('id', bill.payment_id);
        if (batchErr) throw batchErr;
      }
      if (bill.supplier_id) await log(bill.supplier_id, 'bill_unpaid', `Bill ${bill.bill_number || '(no number)'} (${money(bill.amount)}) marked not paid${body.note ? ': ' + String(body.note).slice(0, 200) : ''}`);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('run-supplier-payments failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
