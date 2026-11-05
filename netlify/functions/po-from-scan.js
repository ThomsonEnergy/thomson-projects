// POST /.netlify/functions/po-from-scan   { p }   (backlog item 51)
//
// The person at the counter scans the receipt into a Create PO panel. This saves the receipt as the
// supplier bill and makes the PO from it in one database step (supplier_bill_save_review, po_mode "new",
// run as the caller so the database applies its own rules: any active user may do this, prices on Stock
// items follow the pricing-role rule), then checks the bill against its PO as the server (the check is
// a pricing-role action the caller may not have) and returns the PO for the panel to show.
// p: the same payload the supplier page's review screen sends, with new_po carrying the panel's fields
// (project_id, cost_centre_id, vehicle_id, po_kind, tools_kind, description, notes, show_prices,
// budget_cap, paid_method, paid_on, paid_reference).

const { requireActiveUser } = require('./_shared/require-active-user');
const { getUserClient } = require('./_shared/require-admin');
const { checkBillAndSiblings } = require('./_shared/bill-check');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin } = auth;
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');

  try {
    const { p } = JSON.parse(event.body || '{}');
    if (!p || typeof p !== 'object') return json(400, { ok: false, error: 'Nothing to save.' });
    if (p.po_mode !== 'new') return json(400, { ok: false, error: 'This step only makes a new PO from a scanned invoice.' });
    if (!p.supplier_id) return json(400, { ok: false, error: 'Pick or type the supplier first.' });
    if (!Array.isArray(p.lines) || !p.lines.length) return json(400, { ok: false, error: 'Add at least one line.' });

    const { data: billId, error } = await getUserClient(token).rpc('supplier_bill_save_review', { p });
    if (error && error.code === 'P0001') return json(400, { ok: false, error: error.message });
    if (error) throw error;

    await checkBillAndSiblings(admin, billId);
    const { data: bill } = await admin.from('supplier_bills').select('id, po_id, paid').eq('id', billId).maybeSingle();
    const { data: po } = bill?.po_id
      ? await admin.from('purchase_orders').select('id, po_number, supplier_id, project_id, paid_method').eq('id', bill.po_id).maybeSingle()
      : { data: null };
    return json(200, { ok: true, bill_id: billId, bill_paid: !!bill?.paid, po });
  } catch (err) {
    console.error('po-from-scan failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
