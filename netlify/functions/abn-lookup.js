// GET /.netlify/functions/abn-lookup?name=...   OR   ?abn=...
// Any active logged-in user. Proxies the free ABN Lookup web service
// (abr.business.gov.au) so the registered GUID stays server-side.
//
// ?name= searches for matching entities by name - used to pick a super
// fund from a real list instead of typing its ABN blind. ?abn= verifies
// a single ABN and returns the registered entity name behind it - used
// to confirm an SMSF ABN someone already knows is actually correct.
//
// The service always wraps its response in a JSONP callback (even with
// no callback param given), so that gets stripped before parsing.

const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { getIntegrationKey } = require('./_shared/get-integration-key');

function stripJsonp(text) {
  const match = text.match(/^\s*\w+\((.*)\)\s*$/s);
  return match ? match[1] : text;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const guid = await getIntegrationKey('abr_guid');
    const { name, abn } = event.queryStringParameters || {};

    if (abn) {
      const cleanAbn = abn.replace(/\s+/g, '');
      const res = await fetch(`https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(cleanAbn)}&guid=${encodeURIComponent(guid)}`);
      const data = JSON.parse(stripJsonp(await res.text()));
      if (!data.Abn) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, message: data.Message || 'ABN not found.' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, abn: data.Abn, name: data.EntityName, status: data.AbnStatus }) };
    }

    if (name && name.trim().length >= 3) {
      const res = await fetch(`https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(name.trim())}&maxResults=10&guid=${encodeURIComponent(guid)}`);
      const data = JSON.parse(stripJsonp(await res.text()));
      const results = (data.Names || []).map(n => ({
        name: n.Name, abn: n.Abn, status: n.AbnStatus, state: n.State, postcode: n.Postcode,
      }));
      return { statusCode: 200, body: JSON.stringify({ ok: true, results, message: results.length ? null : (data.Message || 'No matches.') }) };
    }

    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Provide a name or abn parameter (name needs at least 3 characters).' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
