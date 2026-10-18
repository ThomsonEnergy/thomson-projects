// Gmail API client. sales@thomsonenergy.com.au (the shared Sales inbox) is
// connected via a normal Google OAuth consent screen (log into sales@ once, see
// google-oauth-start.js/google-oauth-callback.js) rather than domain-wide
// delegation - so unlike Xero's Custom Connection, there IS a refresh token
// here, stored in api_keys as google_refresh_token. Each person's own Gmail
// (My inbox) has its refresh token in mailbox_tokens instead.
// Access tokens are short-lived (~1hr); same reasoning as
// xero-client.js's 30-minute tokens - just fetch a fresh one every call
// rather than caching across stateless function invocations.
//
// Every call takes an optional mailbox ({ id, address, kind } from the
// mailboxes table). Without one it is sales@, as before.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');
const { getAdminClient } = require('./require-admin');

async function refreshTokenFor(mailbox) {
  if (!mailbox || mailbox.kind !== 'personal') return getIntegrationKey('google_refresh_token');
  const { data } = await getAdminClient().from('mailbox_tokens').select('refresh_token').eq('mailbox_id', mailbox.id).maybeSingle();
  if (!data?.refresh_token) throw new Error(`${mailbox.address} is not connected`);
  return data.refresh_token;
}

async function exchangeRefreshToken(refreshToken) {
  const clientId = await getIntegrationKey('google_client_id');
  const clientSecret = await getIntegrationKey('google_client_secret');

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

async function getGoogleAccessToken(mailbox) {
  return exchangeRefreshToken(await refreshTokenFor(mailbox));
}

const GMAIL_MAILBOX = 'sales@thomsonenergy.com.au';
const userPath = (mailbox) => encodeURIComponent(mailbox && mailbox.kind === 'personal' ? 'me' : GMAIL_MAILBOX);

// Makes an authenticated call to the Gmail API for a mailbox (sales@ when none is given).
// `path` is anything after /users/{mailbox}/, e.g. 'messages' or
// 'messages/send'. Errors carry .status (403 with a scope message means the mailbox
// needs connecting again with the newer permissions).
async function gmailRequest(path, { method = 'GET', body = null, token: givenToken } = {}, mailbox = null) {
  const token = givenToken || await getGoogleAccessToken(mailbox);

  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${userPath(mailbox)}/${path}`, {
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
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return json;
}

// Sends a finished RFC 822 message (a string or Buffer) through Gmail's upload endpoint,
// which takes messages up to 35 MB (the plain JSON endpoint is far smaller) - used when
// there are attachments. Pass threadId to keep a reply in its conversation.
async function gmailUploadSend(rfc822, threadId, mailbox = null) {
  const token = await getGoogleAccessToken(mailbox);
  const boundary = `te_up_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf-8'),
    Buffer.isBuffer(rfc822) ? rfc822 : Buffer.from(rfc822, 'utf-8'),
    Buffer.from(`\r\n--${boundary}--`, 'utf-8'),
  ]);
  const res = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/${userPath(mailbox)}/messages/send?uploadType=multipart`, {
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

module.exports = { getGoogleAccessToken, exchangeRefreshToken, gmailRequest, gmailUploadSend, GMAIL_MAILBOX };
