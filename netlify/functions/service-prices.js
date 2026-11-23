// GET /.netlify/functions/service-prices?token=...
// The disconnect and reconnect price list page (service-prices.html, backlog item 109). Public by
// design: no login, the token in the link (company_settings.service_prices_token) is the check, and
// all it does is read the shown price list items. Writes nothing.

const { getAdminClient } = require('./_shared/require-admin');
const { priceListByToken } = require('./_shared/service-jobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const list = await priceListByToken(getAdminClient(), (event.queryStringParameters || {}).token);
    if (!list) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'This link is not valid.' }) };
    return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: true, ...list }) };
  } catch (err) {
    console.error('service-prices error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Something went wrong. Please call us.' }) };
  }
};
