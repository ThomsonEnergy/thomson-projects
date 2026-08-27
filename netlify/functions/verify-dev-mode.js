// POST /.netlify/functions/verify-dev-mode
// Body: { password }
// Admin only. Checks the submitted password against the DEV_MODE_PASSWORD
// environment variable (never shipped to the browser, unlike a hardcoded
// client-side check) and, if it matches, returns an expiry timestamp 20
// minutes out. The client stores that expiry and uses it to unlock the
// API Keys / Company Details / Xero Mapping settings tabs and bulk-delete
// on Quotes/Projects/Timesheets until it passes.

const { requireAdmin } = require('./_shared/require-admin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { password } = JSON.parse(event.body || '{}');
    const correctPassword = process.env.DEV_MODE_PASSWORD;

    if (!correctPassword) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'DEV_MODE_PASSWORD is not set in Netlify environment variables yet.' }) };
    }
    if (!password || password !== correctPassword) {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Incorrect password' }) };
    }

    const expiresAt = Date.now() + 20 * 60 * 1000;
    return { statusCode: 200, body: JSON.stringify({ ok: true, expiresAt }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
