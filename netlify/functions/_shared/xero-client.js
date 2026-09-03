// Shared Xero API client for Custom Connections (client_credentials grant).
//
// Custom Connections are locked to a single organisation, so unlike a
// standard Xero OAuth app, no Xero-tenant-id header or tenant lookup is
// needed - just a valid access token. Tokens expire after 30 minutes;
// rather than caching (serverless functions are stateless per invocation
// anyway), this just requests a fresh one every call. One extra HTTP call
// per Xero-touching function run, in exchange for never having to think
// about expiry/refresh logic.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

async function getXeroToken() {
  const clientId = await getIntegrationKey('xero_client_id');
  const clientSecret = await getIntegrationKey('xero_client_secret');

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Xero token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Makes an authenticated call to the Xero Accounting or Payroll API.
// `path` should start with the resource, e.g. 'Invoices' or 'Contacts'.
// `api` is 'accounting' or 'payroll.au'.
async function xeroRequest(api, path, { method = 'GET', body = null } = {}) {
  const token = await getXeroToken();
  // Payroll AU only got Timesheets support in the 2.0 API in March 2026,
  // and it's opt-in per organisation - an AU org that hasn't switched
  // over (this one hasn't) gets "Method not allowed for the current
  // customer jurisdiction" from 2.0. 1.0 is the long-established, fully
  // supported AU Payroll API and needs no opt-in.
  const base = api === 'payroll.au'
    ? 'https://api.xero.com/payroll.xro/1.0'
    : 'https://api.xero.com/api.xro/2.0';

  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    // A validation failure's per-field detail lives in an array of
    // elements each carrying its own ValidationErrors - the Accounting
    // API always calls that array "Elements", but Payroll AU echoes it
    // back under the resource's own name instead (e.g. "Employees",
    // "Timesheets"), so json.Message alone is just Xero's generic "A
    // validation exception occurred" with the actual reason still
    // sitting unread in whichever array key Xero used this time.
    const candidateArrays = Object.values(json || {}).filter(Array.isArray);
    const detail = [...new Set(
      candidateArrays.flatMap(arr => arr.flatMap(el => (el?.ValidationErrors || []).map(v => v.Message))).filter(Boolean)
    )];
    const message = (detail.length ? detail.join('; ') : null)
      || json?.Message
      || text
      || `Xero API error ${res.status}`;
    if (!detail.length) console.error('Xero API error, full response:', text);
    throw new Error(message);
  }

  return json;
}

module.exports = { getXeroToken, xeroRequest };
