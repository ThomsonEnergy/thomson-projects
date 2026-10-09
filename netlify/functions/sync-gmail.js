// Scheduled (every 5 minutes, see netlify.toml): pulls new mail for
// sales@thomsonenergy.com.au into email_threads / emails. The "Sync now" buttons use
// sync-gmail-now.js instead, because Netlify does not allow a scheduled function to be
// called over HTTP in production. The work itself lives in _shared/gmail-sync.js.

const { runSync } = require('./_shared/gmail-sync');

exports.handler = async () => {
  try {
    // scheduled functions get about 30 seconds
    const result = await runSync({ budgetMs: 22000 });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    console.error('sync-gmail failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
