// GET /.netlify/functions/test-formbay-trading[?env=cert]
// Admin-only, read-only. Checks the saved Formbay credential against Formbay's "Server API"
// (https://trading.formbay.com.au/formbay/documentation): logs in, then looks at a few read-only lists
// and one real job, and reports what came back - so we know which login works, which Formbay account
// and modules the credential belongs to, and whether a solar (PV) job carries its STC sale details
// (price, count, fees, invoice and tax invoice links). It never writes anything to Formbay.
// Customer names, addresses and phone numbers are never returned: jobs are shown as their shape only,
// apart from the STC "sell_info" block, which holds no personal details.
// ?env=cert uses Formbay's test site (cert-trading.formbay.com.au) instead of the live one.

const fetch = require('node-fetch');
const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');

const BASES = { live: 'https://trading.formbay.com.au', cert: 'https://cert-trading.formbay.com.au' };

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

  let credential;
  try { credential = String(await getIntegrationKey('formbay')).trim(); } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No Formbay key saved in Settings > API Keys yet.' }) };
  }

  const report = { environment: env, login: [], steps: {} };

  // 1. Log in. The documented login takes username + password, or a "basic_token".
  const attempts = [{ label: 'saved key used as basic_token', form: { basic_token: credential } }];
  if (credential.includes(':')) {
    const i = credential.indexOf(':');
    attempts.push({ label: 'saved key read as username:password', form: { username: credential.slice(0, i), password: credential.slice(i + 1) } });
    attempts.push({ label: 'username:password base64-encoded with "Basic " in front, as basic_token', form: { basic_token: 'Basic ' + Buffer.from(credential).toString('base64') } });
  }
  attempts.push({ label: 'saved key base64-encoded as basic_token', form: { basic_token: Buffer.from(credential).toString('base64') } });

  let token = null;
  for (const a of attempts) {
    const r = await call(base, '/formbay/token', { method: 'POST', form: a.form });
    const got = r.json && r.json.access_token;
    report.login.push({ attempt: a.label, status: r.status, gotToken: !!got, message: got ? undefined : (r.json || r.text) });
    if (got) { token = r.json.access_token; report.loginInfo = { token_type: r.json.token_type, expires_in: r.json.expires_in, scope: r.json.scope, user_id: r.json.user_id }; break; }
  }
  if (!token) {
    report.summary = 'Could not log in with any of the three ways tried. Send this result to Formbay support and ask which login the API key is for.';
    return { statusCode: 200, body: JSON.stringify(report, null, 2) };
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
