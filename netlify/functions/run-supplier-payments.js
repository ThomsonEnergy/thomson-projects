// Supplier payments (docs/PO_REVIEW.md Delivery 1). Admin / Finance only.
//
// GET  /.netlify/functions/run-supplier-payments
//      Approved, unpaid bills whose pay-on date (supplier_bills.pay_on: the later of the supplier's
//      terms date and the day we approved) is today in Sydney or earlier, grouped by supplier.
// POST { action: 'mark_paid', bill_ids, paid_on, reference }
//      Records those bills as paid: one supplier_payments row per supplier (the batch), each bill
//      gets paid, paid_at, paid_by, payment_id and the reference. Refuses a bill that is not approved.
// POST { action: 'undo_paid', bill_id, note }
//      Takes a bill back to unpaid (wrong tick) and reduces its batch row.
//
// Sending the money is still done in Airwallex or by bank transfer by hand. Airwallex payouts need a
// payout-enabled API key, a beneficiary per supplier and the accountant's sign-off (backlog item 1);
// when that is built it will create the transfers from the same batch and then call mark_paid.

const { requireFinanceRole } = require('./_shared/require-finance-role');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
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
        .select('id, bill_number, amount, supplier_id, pay_on, due_date, suppliers(name, bank_account_number, bsb, bpay_biller_code)')
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
        bySupplier[sid].bills.push({ id: b.id, billNumber: b.bill_number, amount: Number(b.amount) || 0, payOn: b.pay_on || b.due_date });
      });
      return json(200, { ok: true, today, preview: Object.values(bySupplier) });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'mark_paid') {
      const ids = Array.isArray(body.bill_ids) ? body.bill_ids.filter(Boolean) : [];
      if (!ids.length) return json(400, { ok: false, error: 'Pick at least one bill.' });
      const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(body.paid_on || '') ? body.paid_on : sydneyToday();
      const reference = String(body.reference || '').trim().slice(0, 120) || null;
      const { data: bills, error } = await admin.from('supplier_bills')
        .select('id, bill_number, amount, supplier_id, paid, approved_for_payment, suppliers(name)')
        .in('id', ids);
      if (error) throw error;
      const notApproved = (bills || []).filter(b => !b.approved_for_payment);
      if (notApproved.length) return json(400, { ok: false, error: `Not approved for payment yet: ${notApproved.map(b => b.bill_number || '(no number)').join(', ')}. Approve first.` });
      const toPay = (bills || []).filter(b => !b.paid && b.supplier_id);
      if (!toPay.length) return json(400, { ok: false, error: 'Those bills are already paid.' });

      const groups = {};
      toPay.forEach(b => { (groups[b.supplier_id] = groups[b.supplier_id] || []).push(b); });
      const results = [];
      const now = new Date().toISOString();
      for (const [supplierId, list] of Object.entries(groups)) {
        const total = list.reduce((s, b) => s + (Number(b.amount) || 0), 0);
        const { data: payment, error: payErr } = await admin.from('supplier_payments').insert({
          supplier_id: supplierId, total_amount: total, status: 'paid', initiated_by: user.id,
          paid_on: paidOn, reference, bill_count: list.length,
        }).select('id').single();
        if (payErr) throw payErr;
        const { error: upErr } = await admin.from('supplier_bills')
          .update({ paid: true, paid_at: now, paid_by: user.id, payment_id: payment.id, payment_reference: reference })
          .in('id', list.map(b => b.id)).eq('paid', false);
        if (upErr) throw upErr;
        const name = list[0].suppliers?.name || 'Supplier';
        await log(supplierId, 'bills_paid', `Paid ${money(total)} on ${paidOn}${reference ? ` (${reference})` : ''}: bill${list.length === 1 ? '' : 's'} ${list.map(b => b.bill_number || '(no number)').join(', ')}`);
        results.push({ supplierId, supplier: name, amount: total, billCount: list.length });
      }
      return json(200, { ok: true, results });
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
        const { data: pay } = await admin.from('supplier_payments').select('id, total_amount, bill_count').eq('id', bill.payment_id).maybeSingle();
        if (pay) {
          const total = Math.max(0, (Number(pay.total_amount) || 0) - (Number(bill.amount) || 0));
          await admin.from('supplier_payments').update({ total_amount: total, bill_count: Math.max(0, (pay.bill_count || 1) - 1), status: total > 0 ? 'paid' : 'reversed' }).eq('id', pay.id);
        }
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
