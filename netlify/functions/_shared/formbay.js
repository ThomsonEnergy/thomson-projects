// Formbay (STC forms): the one place that logs in and reads from Formbay.
// Called by formbay-read-background.js. Read only: every request here is a GET, apart from the login.
// Writes nothing itself; the caller decides what to keep.
//
// Login (worked out 14 Oct 2026, docs/HANDOFF_formbay_stc.md): OAuth2 password grant at
// oauth2.formbay.com.au/token, the account's API key as the Basic header, the Formbay username and
// password in the body. Keys formbay, formbay_username, formbay_password (Settings > API Keys).

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const TRADING = 'https://trading.formbay.com.au';
const API = 'https://api.formbay.com.au';
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
async function formbayGet(url, token, { maxText = 400000 } = {}) {
  try {
    const headers = { Accept: 'application/json, text/html;q=0.8' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, timeout: 20000, size: 5 * 1024 * 1024 });
    const type = res.headers.get('content-type') || '';
    if (!/json|text|xml|html/i.test(type)) return { status: res.status, json: null, text: `(not text: ${type})` };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text: json === null ? text.slice(0, maxText) : null };
  } catch (err) {
    return { status: null, json: null, text: String(err.message || err) };
  }
}

// Formbay's trading documentation is a Swagger page with the spec inside the HTML. Pull the spec
// out (the first balanced {...} that starts with "swagger" or "openapi"); null when it is not there.
function swaggerSpecFromHtml(html) {
  const re = /\{\s*"(swagger|openapi)"/g;
  let m;
  while ((m = re.exec(html || ''))) {
    let depth = 0, inString = false;
    for (let i = m.index; i < html.length; i++) {
      const c = html[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(m.index, i + 1)); } catch (e) { break; }
      }
    }
  }
  return null;
}

module.exports = { TRADING, API, formbayLogin, formbayGet, swaggerSpecFromHtml };
