// GET /.netlify/functions/google-oauth-callback
// The redirect target Google sends the browser back to after the consent
// screen. Not bearer-token-gated (Google's redirect can't carry one) -
// security here is the `state` param matching the value
// google-oauth-start.js stored moments earlier for an already-verified
// admin session, same standard OAuth CSRF-guard pattern every provider
// uses for this exact kind of endpoint.

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');

function htmlResponse(title, message) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:40px; text-align:center;">
      <h2>${title}</h2><p>${message}</p></body></html>`,
  };
}

exports.handler = async (event) => {
  const { code, state, error: googleError } = event.queryStringParameters || {};
  const supabaseAdmin = getAdminClient();

  if (googleError) {
    return htmlResponse('Not connected', `Google reported: ${googleError}. Close this tab and try again from Settings.`);
  }
  if (!code || !state) {
    return htmlResponse('Something went wrong', 'Missing code or state from Google. Close this tab and try again from Settings.');
  }

  try {
    const { data: pending } = await supabaseAdmin
      .from('api_keys').select('key_value').eq('key_name', 'google_oauth_pending_state').maybeSingle();
    const parsed = pending?.key_value ? JSON.parse(pending.key_value) : null;
    if (!parsed || parsed.state !== state || Date.now() > parsed.expires_at) {
      return htmlResponse('This link has expired', 'Close this tab and click "Connect" again from Settings - the link is only valid for 10 minutes.');
    }

    const clientId = await getIntegrationKey('google_client_id');
    const clientSecret = await getIntegrationKey('google_client_secret');
    const siteUrl = process.env.URL || 'https://thomsonprojects.netlify.app';
    const redirectUri = `${siteUrl}/.netlify/functions/google-oauth-callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', JSON.stringify(tokenData));
      throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
    }
    if (!tokenData.refresh_token) {
      // Happens if this mailbox already granted access before and Google
      // didn't re-issue a refresh token - prompt=consent on the authorize
      // URL is meant to prevent this, but flag it clearly if it still
      // happens rather than silently overwriting a working token with
      // nothing.
      return htmlResponse(
        'No refresh token returned',
        'Google didn\'t send a refresh token this time. In your Google Account (myaccount.google.com > Security > Third-party access), remove Thomson Projects\' access, then try Connect again from Settings.'
      );
    }

    await supabaseAdmin.from('api_keys').upsert([
      { key_name: 'google_refresh_token', key_value: tokenData.refresh_token },
    ]);
    await supabaseAdmin.from('api_keys').delete().eq('key_name', 'google_oauth_pending_state');

    return htmlResponse('Connected', 'sales@thomsonenergy.com.au is connected. You can close this tab.');
  } catch (err) {
    console.error(err);
    return htmlResponse('Something went wrong', `${err.message}. Close this tab and try again from Settings.`);
  }
};
