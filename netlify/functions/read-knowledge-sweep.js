const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { selfBaseUrl } = require('./_shared/site-url');
const { runAgent } = require('./_shared/agent-log');

// Every 2 minutes (netlify.toml): starts the Knowledge Base reader if a read is queued, or a run died and
// left a job locked past its time. The reading itself is in read-knowledge-background.js (a scheduled
// function only gets 30 seconds).
exports.handler = () => runAgent('read-knowledge-sweep', async () => {
  const admin = getAdminClient();
  const { data: waiting, error } = await admin.from('knowledge_read_jobs').select('id')
    .or(`status.eq.queued,and(status.eq.running,locked_until.lt.${new Date().toISOString()})`)
    .limit(1);
  if (error) throw new Error(error.message);
  if (!waiting || !waiting.length) return { quiet: true };
  const res = await fetch(`${selfBaseUrl()}/.netlify/functions/read-knowledge-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sweep: true }),
  });
  return { summary: `Started the reader (${res.status})` };
});
