// POST /.netlify/functions/supplier-bill-move
// Body: { action, bill_id, ... } - Move to another PO and Remove bill on the PO page and the supplier page
// (js/supplier-bill-actions.js, item 83 part B). Pricing roles only (the same people who save bills).
//
//   move    { bill_id, po_id, note }  move the bill to that PO (po_id null = no PO): supplier_bill_relocate, then
//                                     the bill check runs again on the bill and on every bill of the PO it left
//   remove  { bill_id, reason }       take the bill out of TEops: supplier_bill_remove, then the PO's other bills
//                                     are checked again (quantities and totals add up across a PO's bills)
//
// The database functions do the work all or nothing (lines Accept added to the old PO come off it, received
// goods come back out of stock or off the job, the lines are linked against the new PO) and log on both
// POs and the supplier. This function only decides who may call them and re-runs the checks.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { checkBillAndSiblings, checkBill } = require('./_shared/bill-check');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

async function recheckPo(admin, poId) {
  if (!poId) return;
  const { data: bills } = await admin.from('supplier_bills').select('id').eq('po_id', poId);
  for (const b of bills || []) await checkBill(admin, b.id);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;

  try {
    const { action, bill_id: billId, po_id: poId, note, reason } = JSON.parse(event.body || '{}');
    if (!billId) return json(400, { ok: false, error: 'bill_id is required' });
    const { data: bill } = await admin.from('supplier_bills').select('id, po_id, kind, bill_number').eq('id', billId).maybeSingle();
    if (!bill) return json(404, { ok: false, error: 'That bill was not found.' });
    const oldPoId = bill.po_id;

    if (action === 'move') {
      const { error } = await admin.rpc('supplier_bill_relocate', { p_bill_id: billId, p_po_id: poId || null, p_note: String(note || '').slice(0, 300) || null, p_user: user.id });
      if (error && error.code === 'P0001') return json(400, { ok: false, error: error.message });
      if (error) throw error;
      await checkBillAndSiblings(admin, billId);
      if (oldPoId && oldPoId !== poId) await recheckPo(admin, oldPoId);
      return json(200, { ok: true });
    }

    if (action === 'remove') {
      const { error } = await admin.rpc('supplier_bill_remove', { p_bill_id: billId, p_reason: String(reason || '').slice(0, 300), p_user: user.id });
      if (error && error.code === 'P0001') return json(400, { ok: false, error: error.message });
      if (error) throw error;
      await recheckPo(admin, oldPoId);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('supplier-bill-move failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
