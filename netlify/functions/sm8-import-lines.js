// POST /.netlify/functions/sm8-import-lines
// Body: { jobs: [{ uuid, number, totalIncGst, claims: [{ number, status }] }] }
// Admin only. Second half of the ServiceM8 import dry run: after
// sm8-import-preview.js lists the open jobs, the review screen sends them
// here a few at a time for their line items (two ServiceM8 calls per job,
// too many to do in one call for every job). Returns, per job, the
// prebuild groups and line items it would get, invoiced to date from the
// Completed claims, and any warnings - see buildJobStage in
// _shared/sm8-import.js. Read-only, here and in ServiceM8.

const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { loadSm8JobLines } = require('./_shared/sm8-import');

const MAX_JOBS = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  try {
    const { jobs } = JSON.parse(event.body || '{}');
    if (!Array.isArray(jobs) || !jobs.length) return { statusCode: 400, body: JSON.stringify({ error: 'jobs is required' }) };
    if (jobs.length > MAX_JOBS) return { statusCode: 400, body: JSON.stringify({ error: `Send at most ${MAX_JOBS} jobs per call` }) };
    // ServiceM8 ids only - they go into a filter string.
    if (jobs.some(j => !/^[0-9a-f-]{20,40}$/i.test(String(j.uuid || '')))) return { statusCode: 400, body: JSON.stringify({ error: 'Bad job id' }) };

    const [apiKey, { data: tiers }] = await Promise.all([
      getIntegrationKey('servicem8'),
      auth.supabaseAdmin.from('billable_rate_tiers').select('name'),
    ]);
    const lines = await loadSm8JobLines(apiKey, jobs, (tiers || []).map(t => t.name));
    return { statusCode: 200, body: JSON.stringify({ ok: true, lines }) };
  } catch (err) {
    console.error('sm8-import-lines error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
