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

// Sends a finished RFC 822 message (a string or Buffer) through Gmail's upload endpoint,
// which takes messages up to 35 MB (the plain JSON endpoint is far smaller) - used when
// there are attachments. Pass threadId to keep a reply in its conversation.
async function gmailUploadSend(rfc822, threadId) {
  const token = await getGoogleAccessToken();
  const boundary = `te_up_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf-8'),
    Buffer.isBuffer(rfc822) ? rfc822 : Buffer.from(rfc822, 'utf-8'),
    Buffer.from(`\r\n--${boundary}--`, 'utf-8'),
  ]);
  const res = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(GMAIL_MAILBOX)}/messages/send?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error('Gmail upload send error, full response:', JSON.stringify(json));
    throw new Error(json?.error?.message || `Gmail API error ${res.status}`);
  }
  return json;
}

module.exports = { getGoogleAccessToken, gmailRequest, gmailUploadSend, GMAIL_MAILBOX };
