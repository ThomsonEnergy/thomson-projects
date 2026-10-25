const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { selfBaseUrl } = require('./_shared/site-url');
const { runAgent } = require('./_shared/agent-log');
const { internalHeaders } = require('./_shared/require-internal');

// Every 15 minutes (netlify.toml): starts the retail plan download (sync-energy-plans-background.js)
// when the last good one is over 20 hours old and none is running, so the plans refresh about once a
// day. A download that ran out of time carries on at the next tick; a failed one is tried again in an
// hour. A scheduled function only gets 30 seconds, so the download itself is a background function.
// docs/IDEAS_BACKLOG.md item 34.
function due(last, now = Date.now()) {
  if (!last) return true;
  const age = now - new Date(last.started_at).getTime();
  if (last.status === 'running') return age > 20 * 60000;
  if (last.status === 'ok') return age > 20 * 3600000;
  if (last.status === 'partial') return true;
  return age > 60 * 60000; // failed
}

exports.handler = () => runAgent('sync-energy-plans', async () => {
  const admin = getAdminClient();
  const { data: last } = await admin.from('energy_plan_sync_runs').select('status, started_at').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!due(last)) return { quiet: true };
  const res = await fetch(`${selfBaseUrl()}/.netlify/functions/sync-energy-plans-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ sweep: true }),
  });
  return { summary: `Started the retail plan download (${res.status})` };
});

exports.due = due;
