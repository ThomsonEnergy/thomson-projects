// POST /.netlify/functions/accept-variation
// Body: { token, name, signature }  (token = the variation's own token, the one in
// quote.html?variation=<token>; signature = a PNG data URL drawn on the page)
//
// Public - no staff login, called from the client-facing variation page. Security
// comes from the random token, the same model as accept-quote.js.
//
// A fixed-price variation that has been sent to the client for signing becomes part
// of the job when they sign: it is added as a stage (cost centre) at the agreed
// price - so it is invoiced like any other stage, and shows on the quote - and a
// signed record goes into the job's variations history. Signing twice is harmless.

const { getAdminClient } = require('./_shared/require-admin');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const supabaseAdmin = getAdminClient();

  try {
    const { token, name, signature } = JSON.parse(event.body || '{}');
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'token is required' }) };
    const signedName = String(name || '').trim();
    if (!signedName) return { statusCode: 400, body: JSON.stringify({ error: 'Please type your full name.' }) };
    if (typeof signature !== 'string' || !/^data:image\/png;base64,/.test(signature) || signature.length > 600000) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please draw your signature.' }) };
    }

    const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('*').eq('variation_token', token).eq('variation_type', 'fixed').maybeSingle();
    if (!entry || !['sent', 'approved'].includes(entry.approval_status)) {
      return { statusCode: 404, body: JSON.stringify({ error: 'This variation link is not valid or is no longer open for signing.' }) };
    }
    if (entry.approval_status === 'approved') return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyApproved: true }) };

    const lines = Array.isArray(entry.fixed_lines) ? entry.fixed_lines : [];
    const labour = r2(lines.filter(l => l.item_type === 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
    const material = r2(lines.filter(l => l.item_type !== 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
    const total = r2(labour + material);
    if (!(total > 0)) return { statusCode: 400, body: JSON.stringify({ error: 'This variation has no price on it.' }) };

    const name2 = `Variation ${entry.variation_number || ''}: ${entry.description}`.replace(/\s+:/, ':').slice(0, 90);
    const { data: last } = await supabaseAdmin.from('cost_centres').select('sort_order').eq('project_id', entry.project_id).order('sort_order', { ascending: false }).limit(1);
    const nextSort = ((last || [])[0]?.sort_order ?? -1) + 1;

    // Markup 0: the agreed amounts are the sell prices, billed exactly as quoted.
    const { data: centre, error: ccErr } = await supabaseAdmin.from('cost_centres').insert({
      project_id: entry.project_id, name: name2, description: entry.reason || entry.description, sort_order: nextSort,
      estimated_labour_cost: labour, estimated_material_cost: material, markup_percent: 0, quoted_amount: total,
      variation_entry_id: entry.id,
    }).select('id').single();
    if (ccErr) throw ccErr;

    const { error: liErr } = await supabaseAdmin.from('cost_centre_line_items').insert(lines.map((l, i) => ({
      cost_centre_id: centre.id, description: l.description, item_type: l.item_type === 'labour' ? 'labour' : 'material',
      quantity: 1, unit_cost: Number(l.amount) || 0, sort_order: i,
    })));
    if (liErr) throw liErr;

    const now = new Date().toISOString();
    const { error: upErr } = await supabaseAdmin.from('job_variation_entries').update({
      approval_status: 'approved', approved_at: now, signed_by_name: signedName, signature_data_url: signature, cost_centre_id: centre.id,
    }).eq('id', entry.id).eq('approval_status', 'sent');
    if (upErr) throw upErr;

    // The signed record, alongside the job's other variations.
    await supabaseAdmin.from('variations').insert({
      project_id: entry.project_id, description: `${name2} - ${entry.reason || 'fixed-price variation'}`,
      changes: [{ cost_centre_id: centre.id, cost_centre_name: name2, old_amount: 0, new_amount: total }],
      total_delta: total, variation_type: 'full', status: 'signed',
      signature_data_url: signature, signed_by_name: signedName, signed_at: now, created_by: entry.created_by,
    });

    await supabaseAdmin.from('activity_log').insert({
      entity_type: 'project', entity_id: entry.project_id, action: 'variation_approved',
      description: `${name2} approved and signed by ${signedName} ($${total.toFixed(2)} ex GST)`, changed_by: null,
    });
    if (entry.created_by) {
      await supabaseAdmin.rpc('create_notification', {
        p_user: entry.created_by, p_kind: 'variation', p_title: `Variation signed: ${entry.description}`,
        p_body: `${signedName} approved it ($${total.toFixed(2)} ex GST). It is now a stage on the job.`,
        p_link: `/project.html?id=${entry.project_id}`, p_actor: null, p_dedupe: `variation-approved-${entry.id}`,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('accept-variation error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
