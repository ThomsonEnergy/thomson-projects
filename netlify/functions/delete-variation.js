// POST /.netlify/functions/delete-variation
// Body: { id }
// Deletes a logged variation along with its stage (cost centre). Allowed for a
// pricing role, or for whoever logged it while it is still to bill and not yet
// sent for signing. Refused if anyone has clocked time to it (mark it No charge
// instead - the hours stay on record) or if it has been invoiced / signed.
// Stock materials that were taken off the shelf for it go back into the warehouse.
// A server function because it removes the stage, which staff cannot do themselves.

const { requireActiveUser } = require('./_shared/require-active-user');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin, user } = auth;

  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };

    const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('*').eq('id', id).maybeSingle();
    if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'Variation not found' }) };

    const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
    const isPricing = ['admin', 'finance', 'sales'].includes(profile?.role);
    const isMine = entry.created_by === user.id && entry.status === 'to_bill' && (!entry.approval_status || entry.approval_status === 'draft');
    if (!isPricing && !isMine) return { statusCode: 403, body: JSON.stringify({ error: 'You cannot delete this variation.' }) };

    if (entry.approval_status === 'approved') {
      return { statusCode: 400, body: JSON.stringify({ error: 'The client has signed this variation, so it is part of the job now and cannot be deleted.' }) };
    }

    if (entry.cost_centre_id) {
      const { count: timeCount } = await supabaseAdmin.from('time_entries').select('id', { count: 'exact', head: true }).eq('cost_centre_id', entry.cost_centre_id);
      if (timeCount > 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Time has been clocked to this variation, so it cannot be deleted. Mark it No charge instead.' }) };
      }
      const { count: claimCount } = await supabaseAdmin.from('invoice_claims').select('id', { count: 'exact', head: true }).eq('cost_centre_id', entry.cost_centre_id);
      if (claimCount > 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'This variation has been invoiced, so it cannot be deleted.' }) };
      }
    }

    // The Stock materials taken off the shelf for it, read before the delete below (it cascades to these rows).
    const { data: mats } = await supabaseAdmin.from('job_variation_materials').select('material_id, quantity, stock_deducted, materials(name)').eq('variation_id', id);
    const toPutBack = (mats || []).filter(x => x.stock_deducted && x.material_id);

    // Costs already recorded against the stage go with it.
    if (entry.cost_centre_id) {
      await supabaseAdmin.from('job_material_usage').delete().eq('cost_centre_id', entry.cost_centre_id);
    }
    // The delete comes first, and only the call that deleted the row puts stock back, so two Delete presses
    // can not return the same stock twice (bug review M29).
    const { data: deleted, error: delErr } = await supabaseAdmin.from('job_variation_entries').delete().eq('id', id).select('id');
    if (delErr) throw delErr;
    if (!deleted || !deleted.length) return { statusCode: 404, body: JSON.stringify({ error: 'Variation not found' }) };
    if (entry.cost_centre_id) {
      await supabaseAdmin.from('cost_centre_line_items').delete().eq('cost_centre_id', entry.cost_centre_id);
      await supabaseAdmin.from('cost_centres').delete().eq('id', entry.cost_centre_id);
    }

    // Put Stock materials back on the shelf through _stock_adjust (migration 20261025000000), which locks the
    // stock row: the same call variation_material_delete uses, instead of a read-then-write that a receive or
    // count on the same material at the same moment could overwrite.
    for (const m of toPutBack) {
      const { error: stockErr } = await supabaseAdmin.rpc('_stock_adjust', {
        p_material: m.material_id, p_loc: 'warehouse', p_vehicle: null, p_delta: Number(m.quantity), p_allow_short: false,
      });
      if (stockErr) {
        throw new Error(`The variation was deleted, but ${Number(m.quantity)} x ${m.materials?.name || 'a Stock material'} could not be put back in the Warehouse (${stockErr.message}). Correct the count on the Stock page.`);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('delete-variation error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
