// POST /.netlify/functions/admin-update-time-entry
// Body: { entryId, project_id, cost_centre_id, selected_cost_centre_ids, time_category }
//
// Lets an admin correct which cost centre(s) a logged time_entry is
// attributed to, or reclassify it as office/training/other time - for
// ANY staff member's entry, not just their own. Regular self-service
// editing (public/timesheets.html) only ever touches the caller's own
// rows via direct client-side Supabase calls; this exists specifically
// for the cross-staff case, so it goes through the service-role key
// (requireAdmin) rather than relying on an unconfirmed RLS write policy.

const { requireAdmin } = require('./_shared/require-admin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { entryId, project_id, cost_centre_id, selected_cost_centre_ids, time_category } = JSON.parse(event.body || '{}');
    if (!entryId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('time_entries')
      .select('id')
      .eq('id', entryId)
      .single();
    if (fetchErr || !existing) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Time entry not found' }) };
    }

    // Stored the way the clock-out and the Timesheets editor store it, which is
    // what the costing, variation billing and invoiceable actuals read (see
    // entryCentreIds in _shared/compute-labour-cost.js): one stage goes on
    // cost_centre_id, several (a split entry) go on selected_cost_centre_ids
    // with cost_centre_id null. The list wins when both are sent, as it does
    // when they are read.
    const stageIds = [...new Set((Array.isArray(selected_cost_centre_ids) && selected_cost_centre_ids.length
      ? selected_cost_centre_ids : [cost_centre_id]).filter(Boolean))];
    const { error: updateErr } = await supabaseAdmin
      .from('time_entries')
      .update({
        project_id: project_id || null,
        cost_centre_id: stageIds.length === 1 ? stageIds[0] : null,
        selected_cost_centre_ids: stageIds.length > 1 ? stageIds : null,
        time_category: time_category || 'job',
      })
      .eq('id', entryId);
    if (updateErr) throw updateErr;

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
