// Formbay (STC forms): the one place that talks to Formbay's Server API (trading.formbay.com.au).
// Called by _shared/formbay-sync.js. Takes plain inputs, returns plain results, writes nothing.
// The API list was read from Formbay's own documentation page on 20 Nov 2026 (item 101).
//
// Login (worked out 14 Oct 2026): OAuth2 password grant at oauth2.formbay.com.au/token, the account's
// API key as the Basic header, the Formbay username and password in the body. Keys formbay,
// formbay_username, formbay_password (Settings > API Keys).

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const TRADING = 'https://trading.formbay.com.au';
const OAUTH_URL = 'https://oauth2.formbay.com.au/token';

async function formbayLogin() {
  const key = async (name) => String(await getIntegrationKey(name)).trim();
  const [apiKey, username, password] = [await key('formbay'), await key('formbay_username'), await key('formbay_password')];
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username, password, scope: 'admin' }).toString(),
    timeout: 20000,
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.access_token) throw new Error(`Formbay login failed (HTTP ${res.status})`);
  return json.access_token;
}

// One request to client_api. Returns { status, json, text }; never throws (a failed request has
// status null). `form` sends a form POST (Formbay's document lists are read that way), `json` a JSON POST.
async function formbayCall(token, path, { form = null, json = null, timeout = 20000 } = {}) {
  try {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    const opts = { headers, timeout, size: 5 * 1024 * 1024 };
    if (form) { opts.method = 'POST'; headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
    if (json) { opts.method = 'POST'; headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    const res = await fetch(`${TRADING}/client_api/${path}`, opts);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json: body, text: body === null ? text.slice(0, 2000) : null };
  } catch (err) {
    return { status: null, json: null, text: String(err.message || err) };
  }
}

// One document or photo off a battery form, as bytes. Formbay answers with the address of the file.
async function formbayFile(token, fileId) {
  const res = await fetch(`${TRADING}/client_api/bstc_doc?fileid=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 45000, size: 30 * 1024 * 1024,
  });
  if (!res.ok) throw new Error(`Formbay file ${fileId}: HTTP ${res.status}`);
  return { bytes: await res.buffer(), type: (res.headers.get('content-type') || '').split(';')[0] };
}

module.exports = { formbayLogin, formbayCall, formbayFile };
