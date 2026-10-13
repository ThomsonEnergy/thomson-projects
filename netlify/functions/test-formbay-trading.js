// GET /.netlify/functions/test-formbay-trading[?env=cert]
// Admin-only, read-only. Checks the saved Formbay credential against Formbay's "Server API"
// (https://trading.formbay.com.au/formbay/documentation): logs in, then looks at a few read-only lists
// and one real job, and reports what came back - so we know which login works, which Formbay account
// and modules the credential belongs to, and whether a solar (PV) job carries its STC sale details
// (price, count, fees, invoice and tax invoice links). It never writes anything to Formbay.
// Customer names, addresses and phone numbers are never returned: jobs are shown as their shape only,
// apart from the STC "sell_info" block, which holds no personal details.
// ?env=cert uses Formbay's test site (cert-trading.formbay.com.au) instead of the live one.
// Login uses the Formbay API key (key "formbay") with the Formbay username and password
// (keys "formbay_username" and "formbay_password"), all from Settings > API Keys.

const fetch = require('node-fetch');
const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');

const BASES = { live: 'https://trading.formbay.com.au', cert: 'https://cert-trading.formbay.com.au' };
const OAUTH_URL = 'https://oauth2.formbay.com.au/token';

async function call(base, path, { method = 'GET', form = null, token = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  try {
    const res = await fetch(`${base}${path}`, { method, headers, body, timeout: 20000 });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text: json ? null : text.slice(0, 300) };
  } catch (err) {
    return { status: null, ok: false, json: null, text: err.message };
  }
}

// What a value looks like, without its contents (so no customer details leave this function).
function shape(v, depth = 0) {
  if (Array.isArray(v)) return depth > 3 ? `array(${v.length})` : { array: v.length, first: v.length ? shape(v[0], depth + 1) : null };
  if (v && typeof v === 'object') {
    if (depth > 3) return 'object';
    const out = {};
    Object.keys(v).slice(0, 60).forEach(k => { out[k] = shape(v[k], depth + 1); });
    return out;
  }
  return v === null ? 'null' : typeof v;
}

const stripQuery = (u) => (typeof u === 'string' ? u.split('?')[0] : u);

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireAdmin(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

  const env = (event.queryStringParameters && event.queryStringParameters.env) === 'cert' ? 'cert' : 'live';
  const base = BASES[env];

  const optionalKey = async (name) => { try { return String(await getIntegrationKey(name)).trim(); } catch (err) { return ''; } };
  const apiKey = await optionalKey('formbay');
  let username = await optionalKey('formbay_username');
  let password = await optionalKey('formbay_password');
  // Older setup: username:password was pasted into the API key box itself.
  if (!username && apiKey.includes(':')) { const i = apiKey.indexOf(':'); username = apiKey.slice(0, i); password = apiKey.slice(i + 1); }
  if (!apiKey && !username) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No Formbay key or login saved in Settings > API Keys yet.' }) };
  }

  const report = {
    environment: env,
    saved: { apiKey: !!apiKey && !apiKey.includes(':'), username: !!username, password: !!password },
    login: [], steps: {},
  };

  // 1. Log in.
  // a) Formbay's account page (API Access): OAuth2 password grant at oauth2.formbay.com.au/token, with the
  //    account's API key as the Basic "client credentials" and the Formbay username and password in the body.
  let token = null;
  if (env === 'live' && report.saved.apiKey && username && password) {
    const form = { grant_type: 'password', username, password, scope: 'admin' };
    for (const [label, basic] of [['API key as given', apiKey], ['API key base64-encoded', Buffer.from(apiKey).toString('base64')]]) {
      try {
        const res = await fetch(OAUTH_URL, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
          timeout: 20000,
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        const got = json && json.access_token;
        report.login.push({ attempt: `oauth2.formbay.com.au, ${label}`, status: res.status, gotToken: !!got, message: got ? undefined : (json || text.slice(0, 300)) });
        if (got) { token = json.access_token; report.loginInfo = { via: 'oauth2', token_type: json.token_type, expires_in: json.expires_in, scope: json.scope }; break; }
      } catch (err) {
        report.login.push({ attempt: `oauth2.formbay.com.au, ${label}`, status: null, gotToken: false, message: err.message });
      }
    }
  } else if (env === 'live') {
    report.login.push({ attempt: 'oauth2.formbay.com.au', skipped: 'Needs the Formbay API key plus the Formbay username and password, all saved in Settings > API Keys.' });
  }

  // b) The trading site's own documented login (/formbay/token, username + password or a basic_token).
  if (!token) {
    const attempts = [];
    if (username && password) attempts.push({ label: 'trading site, username + password', form: { username, password } });
    if (report.saved.apiKey) {
      attempts.push({ label: 'trading site, API key as basic_token', form: { basic_token: apiKey } });
      attempts.push({ label: 'trading site, API key base64-encoded as basic_token', form: { basic_token: Buffer.from(apiKey).toString('base64') } });
    }
    for (const a of attempts) {
      const r = await call(base, '/formbay/token', { method: 'POST', form: a.form });
      const got = r.json && r.json.access_token;
      report.login.push({ attempt: a.label, status: r.status, gotToken: !!got, message: got ? undefined : (r.json || r.text) });
      if (got) { token = r.json.access_token; report.loginInfo = { via: 'trading', token_type: r.json.token_type, expires_in: r.json.expires_in, scope: r.json.scope, user_id: r.json.user_id }; break; }
    }
  }
  if (!token) {
    report.summary = 'Could not log in. Check the API key, username and password are all saved (the "saved" section above), then send this result to Formbay support if it still fails.';
    return { statusCode: 200, body: JSON.stringify(report, null, 2) };
  }

  // The OAuth2 token may belong to Formbay's newer API rather than the trading site, so try its entry point too.
  if (report.loginInfo.via === 'oauth2') {
    for (const url of ['https://api.formbay.com.au/entrypoint', 'https://api.formbay.com.au/']) {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        (report.steps.api_formbay ||= []).push({ url, status: res.status, shape: json ? shape(json) : text.slice(0, 300) });
      } catch (err) {
        (report.steps.api_formbay ||= []).push({ url, status: null, message: err.message });
      }
    }
  }

  // 2. Who is this? (account type and which modules are switched on)
  const meta = await call(base, '/auth/auth_metadata', { token });
  report.steps.auth_metadata = { status: meta.status, data: meta.json ? Object.fromEntries(Object.entries(meta.json).filter(([k]) => !/mail|phone|name|address/i.test(k))) : meta.text };

  // 3. Read-only lists
  const clients = await call(base, '/client_api/clients', { token });
  report.steps.clients = { status: clients.status, count: Array.isArray(clients.json) ? clients.json.length : undefined, shape: shape(clients.json) };

  const pvList = await call(base, '/client_api/pv_form_list', { token });
  const pvIds = Array.isArray(pvList.json) ? pvList.json : [];
  report.steps.pv_form_list = { status: pvList.status, count: pvIds.length, newestFew: pvIds.slice(-3) };

  const installers = await call(base, '/client_api/pv_installers', { token });
  report.steps.pv_installers = { status: installers.status, count: Array.isArray(installers.json) ? installers.json.length : undefined, shape: shape(installers.json) };
  const electricians = await call(base, '/client_api/pv_electricians', { token });
  report.steps.pv_electricians = { status: electricians.status, count: Array.isArray(electricians.json) ? electricians.json.length : undefined, shape: shape(electricians.json) };

  // 4. Does a real solar job carry its STC sale details? Look at the newest one.
  if (pvIds.length) {
    const formid = pvIds[pvIds.length - 1];
    report.steps.get_jobs = [];
    for (const ftype of ['pv', 'prcs', 'bstc']) {
      const r = await call(base, `/client_api/get_jobs?ftype=${ftype}&formid=${encodeURIComponent(formid)}`, { token });
      const job = Array.isArray(r.json) ? r.json[0] : r.json;
      const sell = job && job.sell_info;
      report.steps.get_jobs.push({
        ftype, formid, status: r.status,
        shape: shape(job),
        sell_info: sell ? { ...sell, invoiceUrl: stripQuery(sell.invoiceUrl), taxInvoiceUrl: stripQuery(sell.taxInvoiceUrl), logo: undefined } : null,
        message: r.json ? undefined : r.text,
      });
      if (sell) break;
    }
  } else {
    report.steps.get_jobs = 'No solar jobs on this Formbay account to look at.';
  }

  report.summary = 'Logged in. Check "get_jobs" for whether a solar job carries sell_info (STC price, count, fees and invoice links).';
  return { statusCode: 200, body: JSON.stringify(report, null, 2) };
};
