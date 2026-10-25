// GET /.netlify/functions/abn-lookup?name=...   OR   ?abn=...
// Any active logged-in user. Proxies the free ABN Lookup web service
// (abr.business.gov.au) so the registered GUID stays server-side.
//
// ?name= searches for matching entities by name - used to pick a super
// fund from a real list instead of typing its ABN blind. ?abn= verifies
// a single ABN and returns the registered entity name behind it - used
// to confirm an SMSF ABN someone already knows is actually correct.
//
// The calls themselves live in _shared/abr.js, shared with the supplier bill reader.

const { requireActiveUser } = require('./_shared/require-active-user');
const { abnDetails, searchNames } = require('./_shared/abr');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { name, abn } = event.queryStringParameters || {};

    if (abn) {
      const d = await abnDetails(abn);
      if (!d.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, message: d.message }) };
      return { statusCode: 200, body: JSON.stringify({ ok: true, abn: d.abn, name: d.name, status: d.status }) };
    }

    if (name && name.trim().length >= 3) {
      const { results, message } = await searchNames(name);
      return { statusCode: 200, body: JSON.stringify({ ok: true, results, message: results.length ? null : (message || 'No matches.') }) };
    }

    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Provide a name or abn parameter (name needs at least 3 characters).' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
