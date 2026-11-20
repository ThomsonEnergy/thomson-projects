// Formbay (STC forms): the one place that logs in and reads from Formbay.
// Called by formbay-read-background.js. Read only: nothing here changes a Formbay form.
// Writes nothing itself; the caller decides what to keep.
//
// Login (worked out 14 Oct 2026, docs/HANDOFF_formbay_stc.md): OAuth2 password grant at
// oauth2.formbay.com.au/token, the account's API key as the Basic header, the Formbay username and
// password in the body. Keys formbay, formbay_username, formbay_password (Settings > API Keys).

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

// GET one address. Returns { status, json, text }: json when the answer is JSON, else text
// (cut to maxText characters). Never throws: a failed request comes back with status null.
// `form` turns it into a form POST: Formbay's document lists are read that way (they change nothing).
// A redirect is not followed (a document address redirects to the file itself); it comes back as text.
async function formbayGet(url, token, { maxText = 400000, form = null } = {}) {
  try {
    const headers = { Accept: 'application/json, text/html;q=0.8' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts = { headers, timeout: 20000, size: 5 * 1024 * 1024, redirect: 'manual' };
    if (form) { opts.method = 'POST'; headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
    const res = await fetch(url, opts);
    const type = res.headers.get('content-type') || '';
    if (res.status >= 300 && res.status < 400) return { status: res.status, json: null, text: `redirect to ${res.headers.get('location')} (${type}, ${res.headers.get('content-length')} bytes)` };
    if (!/json|text|xml|html/i.test(type)) return { status: res.status, json: null, text: `(not text: ${type}, ${res.headers.get('content-length')} bytes)` };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text: json === null ? text.slice(0, maxText) : null };
  } catch (err) {
    return { status: null, json: null, text: String(err.message || err) };
  }
}


module.exports = { TRADING, formbayLogin, formbayGet };
