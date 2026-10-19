// Shared by accept-variation.js (the client signs on the variation page) and
// variation-approval.js (staff record an approval by email, phone or in person).
// Both do the same thing: the fixed-price variation becomes a stage (cost centre)
// on the job at the agreed price, a signed record goes into the job's variations
// history, and the PDFs are remade in the background.

const { startFinalizeDocuments } = require('./start-finalize-documents');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const METHOD_TEXT = { email: 'by email', phone: 'by phone call', in_person: 'in person' };

// how: { method: 'online' | 'email' | 'phone' | 'in_person', signedName, signature, note, approvedBy, emailThreadId }
async function approveVariation(supabaseAdmin, entry, how) {
  const lines = Array.isArray(entry.fixed_lines) ? entry.fixed_lines : [];
  const labour = r2(lines.filter(l => l.item_type === 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const material = r2(lines.filter(l => l.item_type !== 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const total = r2(labour + material);
  if (!(total > 0)) { const e = new Error('This variation has no price on it.'); e.statusCode = 400; throw e; }

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

  const online = how.method === 'online';
  const who = online ? how.signedName : (entry.client_name || 'the client');
  const howText = online ? `signed by ${how.signedName}` : `${METHOD_TEXT[how.method] || 'manually'}${how.note ? ' (' + how.note + ')' : ''}`;
  const now = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin.from('job_variation_entries').update({
    approval_status: 'approved', approved_at: now, cost_centre_id: centre.id,
    approval_method: how.method, approval_note: how.note || null, approved_by: how.approvedBy || null,
    approval_email_thread_id: how.emailThreadId || null,
    signed_by_name: online ? how.signedName : null, signature_data_url: online ? how.signature : null,
    declined_at: null, declined_by: null, decline_reason: null, expired: false,
  }).eq('id', entry.id).in('approval_status', how.fromStatuses || ['sent']);
  if (upErr) throw upErr;

  // The signed record, alongside the job's other variations.
  await supabaseAdmin.from('variations').insert({
    project_id: entry.project_id, description: `${name2} - ${entry.reason || 'fixed-price variation'}`,
    changes: [{ cost_centre_id: centre.id, cost_centre_name: name2, old_amount: 0, new_amount: total }],
    total_delta: total, variation_type: 'full', status: 'signed',
    signature_data_url: online ? how.signature : null, signed_by_name: online ? how.signedName : `Approved ${howText}`,
    signed_at: now, created_by: entry.created_by,
  });

  await supabaseAdmin.from('activity_log').insert({
    entity_type: 'project', entity_id: entry.project_id, action: 'variation_approved',
    description: `${name2} approved ${howText} ($${total.toFixed(2)} ex GST)`, changed_by: how.approvedBy || null,
  });
  if (entry.created_by && entry.created_by !== how.approvedBy) {
    await supabaseAdmin.rpc('create_notification', {
      p_user: entry.created_by, p_kind: 'variation', p_title: `Variation approved: ${entry.description}`,
      p_body: `${who} approved it ($${total.toFixed(2)} ex GST). It is now a stage on the job.`,
      p_link: `/project.html?id=${entry.project_id}`, p_actor: how.approvedBy || null, p_dedupe: `variation-approved-${entry.id}`,
    });
  }

  // File the old quote PDF as a legacy document, make this variation's signed PDF and a fresh current
  // quote PDF. Runs in the background, so nobody is kept waiting.
  await startFinalizeDocuments({ kind: 'variation_signed', variationId: entry.id });
  return { total, centreId: centre.id };
}

module.exports = { approveVariation };
