// POST /.netlify/functions/supplier-bill-inbox
// Body: { action, id, ... } - the buttons on the Emailed bills page (supplier-bills.html).
// Pricing roles only (the same people who can save supplier bills).
//
//   save          { id, po_id, amount } save the bill against that PO (po_id null = no PO); amount is the
//                                      bill total the person has confirmed (inc GST, as on the bill)
//   set_supplier  { id, supplier_id }  supplier picked by hand: match the POs again
//   mark_saved    { id, bill_id }      saved through the full review screen instead
//   not_a_bill    { id }               not a bill (statement, remittance, spam): put aside
//   reopen        { id }               bring a put-aside or duplicate one back to check
//   retry         { id }               read the file again (after a failure)
//   delete        { id }               a duplicate or something that is not a bill: hide it for good (the row
//                                      stays as 'deleted' so the 30-day Gmail search does not bring it back;
//                                      the stored file is removed)
//   save_paid     { id, po_id, amount, paid_on, reference }
//                                      Admin/Finance: a bill paid before the email came (card at the counter).
//                                      Saves it like 'save' (or takes the saved bill), then approves and records
//                                      it paid in one database step (supplier_bills_approve_and_mark_paid), so it
//                                      never shows in Pay bills due.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { analyse, saveInboxItemAsBill, startSupplierBillProcessing } = require('./_shared/supplier-bill-intake');
const { FINANCE_ROLES } = require('./_shared/require-finance-role');
const { sydneyToday, isCalendarDate } = require('./_shared/bill-check');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin, user, role } = auth;

  try {
    const { action, id, po_id: poId, supplier_id: supplierId, bill_id: billId, amount, paid_on: paidOnRaw, reference: referenceRaw } = JSON.parse(event.body || '{}');
    if (!id) return json(400, { ok: false, error: 'id is required' });
    const { data: item } = await supabaseAdmin.from('supplier_bill_inbox').select('*').eq('id', id).maybeSingle();
    if (!item) return json(404, { ok: false, error: 'That emailed bill was not found.' });
    if (item.status === 'deleted') return json(400, { ok: false, error: 'That emailed bill was deleted.' });
    const resolved = { resolved_by: user.id, resolved_at: new Date().toISOString() };

    if (action === 'save') {
      // the total the reader found is never saved unseen: the person confirms (or corrects) it first
      const confirmedTotal = Number(amount);
      if (!(confirmedTotal > 0)) return json(400, { ok: false, error: 'Confirm the bill total first.' });
      const newBillId = await saveInboxItemAsBill(supabaseAdmin, id, { poId: poId || null, userId: user.id, amount: confirmedTotal });
      return json(200, { ok: true, bill_id: newBillId });
    }

    if (action === 'set_supplier') {
      if (!supplierId) return json(400, { ok: false, error: 'supplier_id is required' });
      if (!item.extracted || item.attachment_part_id === 'none') return json(400, { ok: false, error: 'This one has not been read yet.' });
      const result = await analyse(supabaseAdmin, item, { supplierId });
      await supabaseAdmin.from('supplier_bill_inbox').update(result).eq('id', id);
      return json(200, { ok: true });
    }

    if (action === 'mark_saved') {
      if (!billId) return json(400, { ok: false, error: 'bill_id is required' });
      const { data: bill } = await supabaseAdmin.from('supplier_bills').select('id, supplier_id, po_id').eq('id', billId).maybeSingle();
      if (!bill) return json(404, { ok: false, error: 'That bill was not found.' });
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'saved', bill_id: bill.id, supplier_id: bill.supplier_id, po_id: bill.po_id, ...resolved }).eq('id', id);
      return json(200, { ok: true });
    }

    if (action === 'not_a_bill') {
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'not_a_bill', ...resolved }).eq('id', id);
      return json(200, { ok: true });
    }

    if (action === 'reopen') {
      if (item.status === 'saved') return json(400, { ok: false, error: 'That bill is already saved.' });
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'to_check', duplicate_of_bill_id: null, resolved_by: null, resolved_at: null }).eq('id', id);
      return json(200, { ok: true });
    }

    if (action === 'retry') {
      if (item.attachment_part_id === 'none') return json(400, { ok: false, error: 'There is no file on this email to read.' });
      if (item.status === 'saved') return json(400, { ok: false, error: 'That bill is already saved.' });
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'pending', attempts: 0, error: null }).eq('id', id);
      await startSupplierBillProcessing();
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      if (item.status === 'saved') return json(400, { ok: false, error: 'That bill is saved: it stays. Delete it on the supplier page if it is wrong.' });
      // only a row nobody is working on: one being read (pending, processing) would be written back by the reader
      const { data: gone, error } = await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'deleted', file_path: null, ...resolved })
        .eq('id', id).in('status', ['to_check', 'failed', 'duplicate', 'not_a_bill']).select('id');
      if (error) throw error;
      if (!gone?.length) return json(400, { ok: false, error: 'That one is being read right now. Wait a minute, then try again.' });
      if (item.file_path) {
        const { error: rmErr } = await supabaseAdmin.storage.from('project-documents').remove([item.file_path]);
        if (rmErr) console.error('emailed bill file not removed:', item.file_path, rmErr.message);
      }
      return json(200, { ok: true });
    }

    if (action === 'save_paid') {
      // Record as paid is Admin and Finance only (same as the Suppliers page)
      if (!FINANCE_ROLES.includes(role)) return json(403, { ok: false, error: 'Only Admin or Finance can record a bill as paid.' });
      const paidOn = String(paidOnRaw || '').trim();
      if (!isCalendarDate(paidOn)) return json(400, { ok: false, error: 'Enter the paid date as YYYY-MM-DD.' });
      if (paidOn > sydneyToday()) return json(400, { ok: false, error: 'The paid date cannot be in the future.' });
      const reference = String(referenceRaw || '').trim().slice(0, 120) || null;

      let targetBillId = item.bill_id;
      if (item.status !== 'saved') {
        const confirmedTotal = Number(amount);
        if (!(confirmedTotal > 0)) return json(400, { ok: false, error: 'Confirm the bill total first.' });
        targetBillId = await saveInboxItemAsBill(supabaseAdmin, id, { poId: poId || null, userId: user.id, amount: confirmedTotal });
      }
      if (!targetBillId) return json(400, { ok: false, error: 'That emailed bill has no saved bill to mark paid.' });

      // approve and record paid in one locked database step. If that fails, the bill stays saved but must not
      // sit approved and unpaid (the bill check can approve a bill on a closed PO by itself, and the pay run
      // would then pay it again), so the approval comes off until Already paid is pressed again.
      const { error: paidErr } = await supabaseAdmin.rpc('supplier_bills_approve_and_mark_paid', { p_bill_id: targetBillId, p_paid_on: paidOn, p_reference: reference, p_user: user.id });
      if (paidErr) {
        await supabaseAdmin.from('supplier_bills').update({ approved_for_payment: false, approved_by: null, approved_at: null, pay_on: null }).eq('id', targetBillId).eq('paid', false);
        const why = (paidErr.code === 'P0001' ? paidErr.message : 'the payment could not be recorded').replace(/\.?$/, '.');
        return json(400, { ok: false, error: `The bill is saved but not recorded as paid: ${why} Press Already paid on it again.` });
      }
      return json(200, { ok: true, bill_id: targetBillId });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('supplier-bill-inbox failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
