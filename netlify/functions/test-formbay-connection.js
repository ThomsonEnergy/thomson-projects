// GET /.netlify/functions/test-formbay-connection
// Admin-only. A pure diagnostic - makes no writes to Formbay, just tries
// a few plausible ways of authenticating and calling the documented
// /entrypoint resource (the first request their own docs say to send),
// then reports back exactly what happened with each attempt.
//
// Formbay's public API reference (api-doc.formbay.com.au) confirms OAuth2
// but doesn't state the token endpoint URL - so this tries the credential
// a few reasonable ways rather than assuming one is right. Whatever comes
// back, even an error, tells us something concrete to work from.

const fetch = require('node-fetch');
const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');

const BASE_URL = 'https://api.formbay.com.au';

async function tryEntrypoint(headers, label) {
  try {
    const res = await fetch(`${BASE_URL}/entrypoint`, { headers, method: 'GET' });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    return { label, status: res.status, ok: res.ok, body };
  } catch (err) {
    return { label, status: null, ok: false, error: err.message };
  }
}

async function tryTokenEndpoint(url, credential, label) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(credential).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    return { label, status: res.status, ok: res.ok, body };
  } catch (err) {
    return { label, status: null, ok: false, error: err.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  let credential;
  try {
    credential = await getIntegrationKey('formbay');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No Formbay key saved in Settings > API Keys yet.' }) };
  }

  const attempts = [];

  // Attempt 1: use the credential directly as a Bearer token, in case
  // it's already a long-lived access token rather than client details.
  attempts.push(await tryEntrypoint({ 'Authorization': `Bearer ${credential}` }, 'Direct Bearer token on /entrypoint'));

  // Attempt 2: use it directly as an API key header, in case Formbay
  // expects a custom header rather than standard Bearer auth.
  attempts.push(await tryEntrypoint({ 'X-Api-Key': credential }, 'X-Api-Key header on /entrypoint'));

  // Attempt 3 & 4: treat it as OAuth2 client credentials and try the two
  // most conventional token endpoint URL patterns.
  attempts.push(await tryTokenEndpoint(`${BASE_URL}/oauth/token`, credential, 'OAuth2 token via /oauth/token'));
  attempts.push(await tryTokenEndpoint('https://identity.formbay.com.au/connect/token', credential, 'OAuth2 token via identity.formbay.com.au'));

  const anySuccess = attempts.some(a => a.ok);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      summary: anySuccess
        ? 'At least one attempt succeeded - check which one below.'
        : 'None of these worked. Paste this whole result to Formbay support and ask which auth method and token endpoint is correct.',
      attempts,
    }, null, 2),
  };
};
