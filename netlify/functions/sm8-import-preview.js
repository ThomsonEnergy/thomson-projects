// POST /.netlify/functions/sm8-import-preview
// Body: { quotesSinceMonths } (default 6).
// Admin only. The dry run for the ServiceM8 open-jobs import: reads every
// active Work Order job (and recent open quotes) from ServiceM8 and shows how each would come
// across (client match, job name, quoted and invoiced to date, notes).
// Writes nothing, here or in ServiceM8 - see _shared/sm8-import.js.

const { requireAdmin } = require('./_shared/require-admin');
const { loadSm8OpenJobs } = require('./_shared/sm8-import');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  try {
    const { quotesSinceMonths } = JSON.parse(event.body || '{}');
    const months = Number.isFinite(Number(quotesSinceMonths)) ? Math.min(120, Math.max(0, Number(quotesSinceMonths))) : 6;
    const { rows, summary } = await loadSm8OpenJobs(auth.supabaseAdmin, { quotesSinceMonths: months });
    return { statusCode: 200, body: JSON.stringify({ ok: true, rows, summary }) };
  } catch (err) {
    console.error('sm8-import-preview error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
