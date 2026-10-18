// GET /.netlify/functions/google-oauth-callback
// The redirect target Google sends the browser back to after the consent
// screen. Not bearer-token-gated (Google's redirect can't carry one) -
// security here is the `state` param matching the value
// google-oauth-start.js stored moments earlier for an already-verified
// session, same standard OAuth CSRF-guard pattern every provider
// uses for this exact kind of endpoint.
//
// sales@ (state is a bare random value): token into api_keys, as before.
// My inbox (state "mine.<user id>.<random>"): the Gmail account must be a
// thomsonenergy.com.au address that is not sales@ or invoice@ and not already
// someone else's; token into mailbox_tokens, then its last 60 days start loading.

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { publicBaseUrl } = require('./_shared/site-url');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { gmailRequest } = require('./_shared/google-client');
const { startMailboxWork } = require('./_shared/gmail-sync');
const { FORBIDDEN_PERSONAL } = require('./_shared/mailboxes');

function htmlResponse(title, message) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:40px; text-align:center;">
      <h2>${title}</h2><p>${message}</p></body></html>`,
  };
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

exports.handler = async (event) => {
  const { code, state, error: googleError } = event.queryStringParameters || {};
  const supabaseAdmin = getAdminClient();
  const mineMatch = /^mine\.([0-9a-f-]{36})\.[0-9a-f]+$/.exec(state || '');
  const where = mineMatch ? 'Inbox > My inbox' : 'Settings';

  if (googleError) {
    return htmlResponse('Not connected', `Google reported: ${esc(googleError)}. Close this tab and try again from ${where}.`);
  }
  if (!code || !state) {
    return htmlResponse('Something went wrong', `Missing code or state from Google. Close this tab and try again from ${where}.`);
  }

  try {
    const stateKey = mineMatch ? `google_oauth_pending_state_mine:${mineMatch[1]}` : 'google_oauth_pending_state';
    const { data: pending } = await supabaseAdmin
      .from('api_keys').select('key_value').eq('key_name', stateKey).maybeSingle();
    const parsed = pending?.key_value ? JSON.parse(pending.key_value) : null;
    if (!parsed || parsed.state !== state || Date.now() > parsed.expires_at) {
      return htmlResponse('This link has expired', `Close this tab and click "Connect" again from ${where} - the link is only valid for 10 minutes.`);
    }

    const clientId = await getIntegrationKey('google_client_id');
    const clientSecret = await getIntegrationKey('google_client_secret');
    const siteUrl = publicBaseUrl();
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
        `Google didn't send a refresh token this time. In your Google Account (myaccount.google.com > Security > Third-party access), remove Thomson Projects' access, then try Connect again from ${where}.`
      );
    }
    await supabaseAdmin.from('api_keys').delete().eq('key_name', stateKey);

    if (!mineMatch) {
      await supabaseAdmin.from('api_keys').upsert([
        { key_name: 'google_refresh_token', key_value: tokenData.refresh_token },
      ]);
      await supabaseAdmin.from('mailboxes').update({ scopes: tokenData.scope || null, connected_at: new Date().toISOString(), last_error: null })
        .eq('kind', 'shared');
      return htmlResponse('Connected', 'sales@thomsonenergy.com.au is connected. You can close this tab.');
    }

    // My inbox
    const userId = mineMatch[1];
    const profile = await gmailRequest('profile', { token: tokenData.access_token }, { kind: 'personal' });
    const address = String(profile.emailAddress || '').toLowerCase();
    if (!address.endsWith('@thomsonenergy.com.au') || FORBIDDEN_PERSONAL.includes(address)) {
      return htmlResponse('Not connected', `${esc(address)} can't be connected as your own inbox. Sign in with your own @thomsonenergy.com.au email and try again from Inbox > My inbox.`);
    }
    const { data: taken } = await supabaseAdmin.from('mailboxes').select('id, kind, owner_id').eq('address', address).maybeSingle();
    if (taken && taken.owner_id !== userId) {
      return htmlResponse('Not connected', `${esc(address)} is already connected by someone else.`);
    }
    const { data: old } = await supabaseAdmin.from('mailboxes').select('id, address').eq('kind', 'personal').eq('owner_id', userId).maybeSingle();
    const fresh = {
      address, kind: 'personal', owner_id: userId, scopes: tokenData.scope || null, connected_at: new Date().toISOString(),
      disconnected_at: null, history_id: null, backfill_page_token: null, backfill_done_at: null, last_error: null,
    };
    let mailboxId;
    if (old) {
      if (old.address !== address) {
        return htmlResponse('Not connected', `You connected ${esc(old.address)} before. Disconnect it in Inbox > My inbox first, then connect ${esc(address)}.`);
      }
      await supabaseAdmin.from('mailboxes').update(fresh).eq('id', old.id);
      mailboxId = old.id;
    } else {
      const { data: created, error } = await supabaseAdmin.from('mailboxes').insert(fresh).select('id').single();
      if (error) throw error;
      mailboxId = created.id;
    }
    const { error: tokErr } = await supabaseAdmin.from('mailbox_tokens').upsert({ mailbox_id: mailboxId, refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() });
    if (tokErr) throw tokErr;
    await startMailboxWork();

    return { statusCode: 302, headers: { Location: `${siteUrl}/inbox.html?box=mine&connected=1` }, body: '' };
  } catch (err) {
    console.error(err);
    return htmlResponse('Something went wrong', `${esc(err.message)}. Close this tab and try again from ${where}.`);
  }
};
