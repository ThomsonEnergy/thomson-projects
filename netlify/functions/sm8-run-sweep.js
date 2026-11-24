// Scheduled every 15 minutes (netlify.toml). Keeps the move off ServiceM8 (item 111) going by
// itself: if the run's worker has gone quiet (a crash, a failed hand-over) or its wait after
// ServiceM8's daily limit is over, it starts sm8-run-background.js again. With no run going it
// reads one row and stops.
// Remove this file, its netlify.toml entry and the rest of the ServiceM8 import once ServiceM8 is
// cancelled (docs/IDEAS_BACKLOG.md, owner to-dos).

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { internalHeaders } = require('./_shared/require-internal');
const { selfBaseUrl } = require('./_shared/site-url');
const { runToResume } = require('./_shared/sm8-run');

exports.handler = async () => {
  try {
    const run = await runToResume(getAdminClient());
    if (!run) return { statusCode: 200, body: '' };
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/sm8-run-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalHeaders() },
      body: JSON.stringify({ action: 'continue', runId: run.id }),
    });
    console.log(`sm8-run-sweep: restarted run ${run.id} (${res.status})`);
  } catch (err) {
    console.error('sm8-run-sweep failed:', err.message);
  }
  return { statusCode: 200, body: '' };
};
