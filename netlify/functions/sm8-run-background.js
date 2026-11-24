// POST /.netlify/functions/sm8-run-background
// The move off ServiceM8 (item 111, Settings > ServiceM8 Import). The how is in _shared/sm8-run.js.
//
// Body { action: 'dry_run' }   an admin pressed Dry run: read ServiceM8 and list what would come
//                              across. Nothing is added to clients, jobs or quotes.
// Body { action: 'start' }     an admin pressed Bring everything across.
// Body { action: 'continue', runId }   this function calling itself when its 15 minutes are
//                              nearly up, or sm8-run-sweep.js restarting a run that stopped.
//                              Carries the internal secret, not a login.
//
// A background function (15 minute limit): the whole account takes hours, so each go does what it
// can in 13 minutes and then starts the next. Only reads from ServiceM8.

const fetch = require('node-fetch');
const { requireAdmin, getAdminClient } = require('./_shared/require-admin');
const { requireInternal, internalHeaders } = require('./_shared/require-internal');
const { selfBaseUrl } = require('./_shared/site-url');
const { startRun, runStep } = require('./_shared/sm8-run');

// Stop starting new work with time to spare before the 15 minute limit.
const TIME_BUDGET_MS = 13 * 60 * 1000;

exports.handler = async (event) => {
  const started = Date.now();
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (err) { return { statusCode: 400, body: '' }; }

  let db, runId;
  try {
    if (body.action === 'continue') {
      if (!requireInternal(event) || !body.runId) return { statusCode: 403, body: '' };
      db = getAdminClient();
      runId = body.runId;
    } else if (body.action === 'dry_run' || body.action === 'start') {
      const auth = await requireAdmin(event);
      if (!auth) return { statusCode: 403, body: '' };
      db = auth.supabaseAdmin;
      const { run, already } = await startRun(db, auth.user.id, body.action === 'start' ? 'full' : 'dry_run');
      // One already going has its own worker (and the sweep behind it).
      if (already) return { statusCode: 200, body: '' };
      runId = run.id;
    } else {
      return { statusCode: 400, body: '' };
    }

    const { more } = await runStep(db, runId, started + TIME_BUDGET_MS);
    if (more) {
      await fetch(`${selfBaseUrl()}/.netlify/functions/sm8-run-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalHeaders() },
        body: JSON.stringify({ action: 'continue', runId }),
      });
    }
  } catch (err) {
    console.error('sm8-run-background error:', err.message);
  }
  return { statusCode: 200, body: '' };
};
