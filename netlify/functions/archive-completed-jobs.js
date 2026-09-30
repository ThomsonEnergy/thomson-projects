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

exports.handler = async () => {
  try {
    const supabaseAdmin = getAdminClient();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('projects')
      .update({ pipeline_stage: 'archived' })
      .eq('pipeline_stage', 'complete')
      .lt('completed_at', twoDaysAgo)
      .select('id');
    if (error) throw error;

    console.log(`archive-completed-jobs: archived ${data?.length || 0} job(s) complete for over 2 days.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, archived: data?.length || 0 }) };
  } catch (err) {
    console.error('archive-completed-jobs failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
