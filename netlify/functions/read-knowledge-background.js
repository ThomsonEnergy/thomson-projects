// POST /.netlify/functions/read-knowledge-background
// Body: { job_id } to work on one queued read, or { sweep: true } to work on whatever is queued.
//
// Background function (up to 15 minutes). The queue (knowledge_read_jobs) is the only way in: a job is
// queued by a logged-in person on the Knowledge page (RLS), this just works through what is there, so no
// login is needed to poke it. See _shared/knowledge-reader.js for the reading itself.

const { getAdminClient } = require('./_shared/require-admin');
const { runJob, nextJobId, callSelf } = require('./_shared/knowledge-reader');

exports.handler = async (event) => {
  let jobId = null, sweep = false;
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.job_id || null;
    sweep = !!body.sweep;
  } catch { return { statusCode: 202, body: '' }; }

  const admin = getAdminClient();
  try {
    if (!jobId && sweep) jobId = await nextJobId(admin);
    if (!jobId) return { statusCode: 202, body: '' };
    const result = await runJob(admin, jobId);
    console.log(`read-knowledge ${jobId}: ${result}`);
    // Anything else waiting gets its own run straight after.
    if (result !== 'more' && await nextJobId(admin)) await callSelf({ sweep: true });
  } catch (err) {
    console.error('read-knowledge-background failed:', err);
  }
  return { statusCode: 202, body: '' };
};
