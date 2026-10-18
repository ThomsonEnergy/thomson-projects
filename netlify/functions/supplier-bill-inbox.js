// POST /.netlify/functions/supplier-bill-inbox
// Body: { action, id, ... } - the buttons on the Emailed bills page (supplier-bills.html).
// Pricing roles only (the same people who can save supplier bills).
//
//   save          { id, po_id }        save the bill against that PO (po_id null = no PO)
//   set_supplier  { id, supplier_id }  supplier picked by hand: match the POs again
//   mark_saved    { id, bill_id }      saved through the full review screen instead
//   not_a_bill    { id }               not a bill (statement, remittance, spam): put aside
//   reopen        { id }               bring a put-aside or duplicate one back to check
//   retry         { id }               read the file again (after a failure)

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { analyse, saveInboxItemAsBill, startSupplierBillProcessing } = require('./_shared/supplier-bill-intake');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin, user } = auth;

  try {
    const { action, id, po_id: poId, supplier_id: supplierId, bill_id: billId } = JSON.parse(event.body || '{}');
    if (!id) return json(400, { ok: false, error: 'id is required' });
    const { data: item } = await supabaseAdmin.from('supplier_bill_inbox').select('*').eq('id', id).maybeSingle();
    if (!item) return json(404, { ok: false, error: 'That emailed bill was not found.' });
    const resolved = { resolved_by: user.id, resolved_at: new Date().toISOString() };

    if (action === 'save') {
      const newBillId = await saveInboxItemAsBill(supabaseAdmin, id, { poId: poId || null, userId: user.id });
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

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('supplier-bill-inbox failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
