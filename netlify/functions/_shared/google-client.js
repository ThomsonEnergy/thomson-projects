// Shared Gmail API client, for the sales@thomsonenergy.com.au shared
// inbox. Connected via a normal Google OAuth consent screen (log into
// sales@ once, see google-oauth-start.js/google-oauth-callback.js) rather
// than domain-wide delegation - so unlike Xero's Custom Connection, there
// IS a refresh token here, stored in api_keys as google_refresh_token.
// Access tokens are short-lived (~1hr); same reasoning as
// xero-client.js's 30-minute tokens - just fetch a fresh one every call
// rather than caching across stateless function invocations.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

async function getGoogleAccessToken() {
  const clientId = await getIntegrationKey('google_client_id');
  const clientSecret = await getIntegrationKey('google_client_secret');
  const refreshToken = await getIntegrationKey('google_refresh_token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

const GMAIL_MAILBOX = 'sales@thomsonenergy.com.au';
const GMAIL_BASE = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(GMAIL_MAILBOX)}`;

// Makes an authenticated call to the Gmail API for the sales@ mailbox.
// `path` is anything after /users/{mailbox}/, e.g. 'messages' or
// 'messages/send'.
async function gmailRequest(path, { method = 'GET', body = null } = {}) {
  const token = await getGoogleAccessToken();

  const res = await fetch(`${GMAIL_BASE}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const message = json?.error?.message || `Gmail API error ${res.status}`;
    console.error('Gmail API error, full response:', JSON.stringify(json));
    throw new Error(message);
  }

  return json;
}

module.exports = { getGoogleAccessToken, gmailRequest, GMAIL_MAILBOX };
