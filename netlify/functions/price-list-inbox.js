// POST /.netlify/functions/price-list-inbox
// Body: { action, id, ... } - the buttons on the Price lists page (price-lists.html).
// Pricing roles only (Admin, Finance, Sales). The work lives in _shared/price-list-intake.js.
//
//   apply_change   { id }               apply one waiting change (price, match or replacement)
//   skip_change    { id }               leave our price / do not link
//   undo_change    { id }               put an applied change back
//   apply_all      { id: import id }    apply every waiting change from one price list
//   set_supplier   { id, supplier_id }  supplier picked by hand: compare the list now
//   read_all       { id }               a very large file: read every page anyway
//   not_price_list { id }               put the file aside
//   retry          { id }               read the file again from the start

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { applyPriceList, applyChange, skipChange, undoChange, startPriceListProcessing } = require('./_shared/price-list-intake');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;

  try {
    const { action, id, supplier_id: supplierId } = JSON.parse(event.body || '{}');
    if (!id) return json(400, { ok: false, error: 'id is required' });
    const now = new Date().toISOString();

    if (action === 'apply_change') { await applyChange(admin, id, user.id); return json(200, { ok: true }); }
    if (action === 'skip_change') { await skipChange(admin, id, user.id); return json(200, { ok: true }); }
    if (action === 'undo_change') { await undoChange(admin, id, user.id); return json(200, { ok: true }); }

    const { data: imp } = await admin.from('price_list_imports').select('*').eq('id', id).maybeSingle();
    if (!imp) return json(404, { ok: false, error: 'That price list was not found.' });

    if (action === 'apply_all') {
      const { data: waiting } = await admin.from('price_changes').select('id').eq('import_id', id).eq('status', 'waiting');
      let applied = 0;
      for (const c of waiting || []) { await applyChange(admin, c.id, user.id); applied += 1; }
      return json(200, { ok: true, applied });
    }
    if (action === 'set_supplier') {
      if (!supplierId) return json(400, { ok: false, error: 'supplier_id is required' });
      if (!(imp.items || []).length) return json(400, { ok: false, error: 'Nothing has been read from this file yet.' });
      await admin.from('price_list_imports').update({ supplier_id: supplierId }).eq('id', id);
      const r = await applyPriceList(admin, id);
      return json(200, { ok: true, summary: r.summary });
    }
    if (action === 'read_all') {
      await admin.from('price_list_imports').update({ allow_large: true, status: 'pending', attempts: 0, error: null }).eq('id', id);
      await startPriceListProcessing();
      return json(200, { ok: true });
    }
    if (action === 'not_price_list') {
      await admin.from('price_list_imports').update({ status: 'not_a_price_list', resolved_by: user.id, resolved_at: now }).eq('id', id);
      await admin.from('price_changes').update({ status: 'skipped', resolved_by: user.id, resolved_at: now }).eq('import_id', id).eq('status', 'waiting');
      return json(200, { ok: true });
    }
    if (action === 'retry') {
      await admin.from('price_list_imports').update({ status: 'pending', attempts: 0, error: null, pages_done: 0, items: [] }).eq('id', id);
      await startPriceListProcessing();
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('price-list-inbox failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
