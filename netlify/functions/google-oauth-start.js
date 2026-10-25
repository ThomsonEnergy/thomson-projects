// GET /.netlify/functions/google-oauth-start            sales@ (admin only, Settings)
// GET /.netlify/functions/google-oauth-start?mailbox=mine  your own work Gmail (any staff, Inbox > My inbox)
// Returns the Google consent-screen URL to send the browser to; the page then does
// window.location.href = url.
//
// My inbox: only after the Gmail notice (Workplace Surveillance Act 2005 (NSW)) was
// shown. Agreeing (and waiving the 14 days notice) allows it straight away; not
// agreeing locks it for 14 days from the notice (gmail_connect_allowed_from()).
//
// The `state` param is Google's standard CSRF guard - a random value we
// generate here and check again in google-oauth-callback.js, so a
// callback request can't be replayed/forged from outside this flow. It's
// stored as a short-lived api_keys row (google_oauth_pending_state, or
// google_oauth_pending_state_mine:<user id> for My inbox) rather than a new
// table, checked for a 10-minute expiry on the way back.

const { requireAdmin } = require('./_shared/require-admin');
const { requireActiveUser } = require('./_shared/require-active-user');
const { publicBaseUrl } = require('./_shared/site-url');
const crypto = require('crypto');

// gmail.modify: read, labels, archive, drafts (everything but permanent delete)
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const mine = (event.queryStringParameters || {}).mailbox === 'mine';

  const auth = mine ? await requireActiveUser(event) : await requireAdmin(event);
  if (!auth) {
    return json(403, { ok: false, error: mine ? 'Not signed in' : 'Admin access required' });
  }

  try {
    const { supabaseAdmin } = auth;
    const { data: existing, error: keyErr } = await supabaseAdmin
      .from('api_keys').select('key_value').eq('key_name', 'google_client_id').maybeSingle();
    if (keyErr) throw keyErr;
    if (!existing?.key_value) {
      return json(400, { ok: false, error: mine ? 'Gmail is not set up for TEops yet. Ask an admin.' : 'Save the Google Client ID and Client Secret first.' });
    }
    const clientId = existing.key_value;

    if (mine) {
      const { data: allowedFrom } = await supabaseAdmin.rpc('gmail_connect_allowed_from', { p_profile_id: auth.user.id });
      if (!allowedFrom) return json(400, { ok: false, error: 'Read the Gmail notice first.' });
      if (new Date(allowedFrom).getTime() > Date.now()) {
        return json(400, { ok: false, error: `You can connect your Gmail from ${new Date(allowedFrom).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' })} (14 days after the notice).` });
      }
    }

    const random = crypto.randomBytes(24).toString('hex');
    const state = mine ? `mine.${auth.user.id}.${random}` : random;
    const { error: stateErr } = await supabaseAdmin.from('api_keys').upsert({
      key_name: mine ? `google_oauth_pending_state_mine:${auth.user.id}` : 'google_oauth_pending_state',
      key_value: JSON.stringify({ state, expires_at: Date.now() + 10 * 60 * 1000 }),
      updated_by: auth.user.id,
    });
    if (stateErr) throw stateErr;

    const siteUrl = publicBaseUrl();
    const redirectUri = `${siteUrl}/.netlify/functions/google-oauth-callback`;

    const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: mine ? (auth.user.email || '') : 'sales@thomsonenergy.com.au',
      state,
    })}`;

    return json(200, { ok: true, url: authorizeUrl });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message });
  }
};
