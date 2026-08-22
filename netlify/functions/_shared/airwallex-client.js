// Shared Airwallex API client.
//
// Auth: POST /api/v1/authentication/login with x-api-key and x-client-id
// headers, returns a token valid for 30 minutes. Like the Xero client,
// this just requests a fresh token per call rather than caching one -
// simpler, at the cost of one extra HTTP call per Airwallex-touching
// function run.
//
// Base URL confirmed from Airwallex's own Payment Links/Webhooks/
// Authentication API reference pages - if this turns out to be wrong in
// practice, the fix is one line here, not a rewrite.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const BASE_URL = 'https://api.airwallex.com';

async function getAirwallexToken() {
  const clientId = await getIntegrationKey('airwallex_client_id');
  const apiKey = await getIntegrationKey('airwallex_api_key');

  const res = await fetch(`${BASE_URL}/api/v1/authentication/login`, {
    method: 'POST',
    headers: {
      'x-client-id': clientId,
      'x-api-key': apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airwallex token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.token;
}

// Makes an authenticated call to the Airwallex API. `path` should start
// after /api/v1, e.g. 'pa/payment_links/create'.
async function airwallexRequest(path, { method = 'GET', body = null } = {}) {
  const token = await getAirwallexToken();

  const res = await fetch(`${BASE_URL}/api/v1/${path}`, {
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
    const message = json?.message || json?.code || text || `Airwallex API error ${res.status}`;
    throw new Error(message);
  }

  return json;
}

module.exports = { getAirwallexToken, airwallexRequest };
