// Scheduled function (see netlify.toml - runs @daily, no manual trigger
// or UI step needed, Netlify enables scheduled functions by default).
// This app's first ever cron job - everything else has been direct user
// action or a webhook until now.
//
// Moves any job that's been sitting at 'complete' for more than 2 days
// into 'archived', taking it off the active Job Pipeline board
// (dashboard.html already excludes archived from its query) - the
// Archived link next to the "Complete" column is where it lives after
// that, not gone, just out of the way of the day-to-day board.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');

// Reports to the ops manager (_shared/agent-log.js).
exports.handler = () => runAgent('archive-completed-jobs', async () => {
  const supabaseAdmin = getAdminClient();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('projects')
    .update({ pipeline_stage: 'archived' })
    .eq('pipeline_stage', 'complete')
    .lt('completed_at', twoDaysAgo)
    .select('id');
  if (error) throw error;

  const archived = data?.length || 0;
  console.log(`archive-completed-jobs: archived ${archived} job(s) complete for over 2 days.`);
  return { quiet: !archived, summary: `${archived} job${archived === 1 ? '' : 's'} archived`, response: { statusCode: 200, body: JSON.stringify({ ok: true, archived }) } };
});
