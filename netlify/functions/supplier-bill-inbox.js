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
//                                      Saves it like 'save' (or takes the saved bill), approves it and records
//                                      it paid through supplier_bills_mark_paid, so it never shows in Pay bills due.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { requireFinanceRole } = require('./_shared/require-finance-role');
const { analyse, saveInboxItemAsBill, startSupplierBillProcessing } = require('./_shared/supplier-bill-intake');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin, user } = auth;

  try {
    const { action, id, po_id: poId, supplier_id: supplierId, bill_id: billId, amount, paid_on: paidOnRaw, reference: referenceRaw } = JSON.parse(event.body || '{}');
    if (!id) return json(400, { ok: false, error: 'id is required' });
    const { data: item } = await supabaseAdmin.from('supplier_bill_inbox').select('*').eq('id', id).maybeSingle();
    if (!item) return json(404, { ok: false, error: 'That emailed bill was not found.' });
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
      if (item.file_path) {
        const { error: rmErr } = await supabaseAdmin.storage.from('project-documents').remove([item.file_path]);
        if (rmErr) console.error('emailed bill file not removed:', item.file_path, rmErr.message);
      }
      const { error } = await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'deleted', file_path: null, ...resolved }).eq('id', id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    if (action === 'save_paid') {
      // Record as paid is Admin and Finance only (same as the Suppliers page)
      if (!(await requireFinanceRole(event))) return json(403, { ok: false, error: 'Only Admin or Finance can record a bill as paid.' });
      const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(paidOnRaw || '') ? paidOnRaw : sydneyToday();
      if (paidOn > sydneyToday()) return json(400, { ok: false, error: 'The paid date cannot be in the future.' });
      const reference = String(referenceRaw || '').trim().slice(0, 120) || null;
      let targetBillId = item.bill_id;
      if (item.status !== 'saved') {
        const confirmedTotal = Number(amount);
        if (!(confirmedTotal > 0)) return json(400, { ok: false, error: 'Confirm the bill total first.' });
        targetBillId = await saveInboxItemAsBill(supabaseAdmin, id, { poId: poId || null, userId: user.id, amount: confirmedTotal });
      }
      if (!targetBillId) return json(400, { ok: false, error: 'That emailed bill has no saved bill to mark paid.' });
      const { data: bill } = await supabaseAdmin.from('supplier_bills').select('id, bill_number, paid, approved_for_payment, supplier_id').eq('id', targetBillId).maybeSingle();
      if (!bill) return json(404, { ok: false, error: 'That bill was not found.' });
      if (bill.paid) return json(400, { ok: false, error: `Bill ${bill.bill_number || ''} is already recorded as paid.`.replace(/\s+/g, ' ') });
      if (!bill.supplier_id) return json(400, { ok: false, error: 'Pick the supplier first.' });
      // paid already, so approval is a formality: approve it, then the same locked step the Suppliers page uses
      if (!bill.approved_for_payment) {
        const { error: apprErr } = await supabaseAdmin.from('supplier_bills')
          .update({ approved_for_payment: true, approved_by: user.id, approved_at: new Date().toISOString(), pay_on: paidOn }).eq('id', bill.id);
        if (apprErr) throw apprErr;
      }
      const { error: paidErr } = await supabaseAdmin.rpc('supplier_bills_mark_paid', { p_bill_ids: [bill.id], p_paid_on: paidOn, p_reference: reference, p_user: user.id });
      if (paidErr) {
        const why = (paidErr.code === 'P0001' ? paidErr.message : 'the payment could not be recorded').replace(/\.?$/, '.');
        return json(400, { ok: false, error: `The bill is saved but not marked paid: ${why} Record it paid on the supplier page.` });
      }
      return json(200, { ok: true, bill_id: bill.id });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('supplier-bill-inbox failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
