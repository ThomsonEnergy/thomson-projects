// GET /.netlify/functions/google-oauth-start
// Admin-only. Returns the Google consent-screen URL to send the browser
// to, for connecting sales@thomsonenergy.com.au's Gmail. Settings'
// "Connect" button calls this then does window.location.href = url.
//
// The `state` param is Google's standard CSRF guard - a random value we
// generate here and check again in google-oauth-callback.js, so a
// callback request can't be replayed/forged from outside this flow. It's
// stored as a short-lived api_keys row (google_oauth_pending_state) rather
// than a new table, checked for a 10-minute expiry on the way back.

const { requireAdmin } = require('./_shared/require-admin');
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Admin access required' }) };
  }

  try {
    const { supabaseAdmin } = auth;
    const { data: existing, error: keyErr } = await supabaseAdmin
      .from('api_keys').select('key_value').eq('key_name', 'google_client_id').maybeSingle();
    if (keyErr) throw keyErr;
    if (!existing?.key_value) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Save the Google Client ID and Client Secret first.' }) };
    }
    const clientId = existing.key_value;

    const state = crypto.randomBytes(24).toString('hex');
    const { error: stateErr } = await supabaseAdmin.from('api_keys').upsert({
      key_name: 'google_oauth_pending_state',
      key_value: JSON.stringify({ state, expires_at: Date.now() + 10 * 60 * 1000 }),
      updated_by: auth.user.id,
    });
    if (stateErr) throw stateErr;

    const siteUrl = process.env.URL || 'https://thomsonprojects.netlify.app';
    const redirectUri = `${siteUrl}/.netlify/functions/google-oauth-callback`;

    const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: 'sales@thomsonenergy.com.au',
      state,
    })}`;

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: authorizeUrl }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
