// POST /.netlify/functions/read-knowledge-background
// Body: { job_id } to work on one queued read, or { sweep: true } to work on whatever is queued.
//
// Background function (up to 15 minutes). The queue (knowledge_read_jobs) is the only way in: a job is
// queued by a logged-in person on the Knowledge page (RLS), this just works through what is there. A poke
// must carry the internal secret (the sweep, the reader calling itself) or an active staff login
// (the Knowledge page, Authorization: Bearer); anything else does nothing (S29 in
// docs/BUG_REVIEW_2026-10-23.md). See _shared/knowledge-reader.js for the reading itself.

const { getAdminClient } = require('./_shared/require-admin');
const { requireInternal } = require('./_shared/require-internal');
const { requireActiveUser } = require('./_shared/require-active-user');
const { runJob, nextJobId, callSelf } = require('./_shared/knowledge-reader');

exports.handler = async (event) => {
  if (!requireInternal(event) && !(await requireActiveUser(event))) {
    console.error('read-knowledge-background: refused, no internal secret and no valid login');
    return { statusCode: 403, body: '' };
  }
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
