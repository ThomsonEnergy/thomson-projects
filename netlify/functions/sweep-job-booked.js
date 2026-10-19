// Scheduled function (see netlify.toml): just after midnight Sydney time.
// A job is only Job Booked while someone is scheduled to it (today or
// later) or clocked in (migration 20261023000000). That rule re-checks a
// job when its bookings or clock-ins change; this catches the ones whose
// last booking simply slipped into the past. Moves them back to Ready to
// Book (or Awaiting Action if required tasks are open). Migration
// 20261024000000.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');

// Reports to the ops manager (_shared/agent-log.js).
exports.handler = () => runAgent('sweep-job-booked', async () => {
  const supabaseAdmin = getAdminClient();
  const { data, error } = await supabaseAdmin.rpc('sweep_job_booked');
  if (error) throw error;

  const moved = data || [];
  const label = { ready_to_book: 'Ready to Book', awaiting_action: 'Awaiting Action' };
  const details = moved.map(r => `J${r.job_number} to ${label[r.new_stage] || r.new_stage}`).join(', ');
  console.log(`sweep-job-booked: moved ${moved.length} job(s) out of Job Booked. ${details}`);
  return {
    quiet: !moved.length,
    summary: `${moved.length} job${moved.length === 1 ? '' : 's'} moved out of Job Booked (nobody scheduled or clocked in)`,
    details,
    response: { statusCode: 200, body: JSON.stringify({ ok: true, moved }) },
  };
});
