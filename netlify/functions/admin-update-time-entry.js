// POST /.netlify/functions/admin-update-time-entry
// Body: { entryId, project_id, cost_centre_id, selected_cost_centre_ids, time_category }
//       { entryId, clock_in, clock_out }   ServiceM8 entries only: correct the times
//       { entryId, delete: true }          ServiceM8 entries only: remove it
//
// Lets an admin correct which cost centre(s) a logged time_entry is
// attributed to, or reclassify it as office/training/other time - for
// ANY staff member's entry, not just their own. Regular self-service
// editing (public/timesheets.html) only ever touches the caller's own
// rows via direct client-side Supabase calls; this exists specifically
// for the cross-staff case, so it goes through the service-role key
// (requireAdmin) rather than relying on an unconfirmed RLS write policy.
//
// ServiceM8 imports (sm8_activity_uuid set, already paid) can be wrong in
// ServiceM8 itself, so an admin can fix their times or delete them here.
// Only those: our own staff's times are edited in Timesheets, where the
// Xero lock applies. A deleted import is remembered by a trigger
// (sm8_deleted_activities, migration 20261125000000) so a re-run of the
// ServiceM8 import does not bring it back.

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
    const body = JSON.parse(event.body || '{}');
    const { entryId, project_id, cost_centre_id, selected_cost_centre_ids, time_category } = body;
    if (!entryId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('time_entries')
      .select('id, sm8_activity_uuid')
      .eq('id', entryId)
      .single();
    if (fetchErr || !existing) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Time entry not found' }) };
    }

    const wantsTimes = body.clock_in !== undefined || body.clock_out !== undefined;
    if ((body.delete || wantsTimes) && !existing.sm8_activity_uuid) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Only ServiceM8 entries can have their times changed or be deleted here. Edit this one in Timesheets.' }) };
    }

    if (body.delete) {
      const { error: delErr } = await supabaseAdmin.from('time_entries').delete().eq('id', entryId);
      if (delErr) throw delErr;
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    let timePatch = {};
    if (wantsTimes) {
      const inMs = Date.parse(body.clock_in);
      const outMs = Date.parse(body.clock_out);
      if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Start and finish are both needed.' }) };
      }
      if (outMs <= inMs) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Finish must be after start.' }) };
      }
      if (outMs - inMs > 24 * 3600000) {
        return { statusCode: 400, body: JSON.stringify({ error: 'One entry cannot be longer than 24 hours.' }) };
      }
      timePatch = { clock_in: new Date(inMs).toISOString(), clock_out: new Date(outMs).toISOString() };
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
        ...timePatch,
      })
      .eq('id', entryId);
    if (updateErr) throw updateErr;

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
