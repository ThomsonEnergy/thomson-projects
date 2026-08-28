// GET /.netlify/functions/get-xero-chart-of-accounts
// Pricing roles only (same guard as every other Xero-touching function).
// Returns the real chart of accounts and tax rates straight from Xero, so
// Settings > Xero Mapping can offer a dropdown of what actually exists in
// this org instead of someone typing a code by hand - which is exactly
// how a mismatch like storing "GST on Income" (the human label Xero shows
// in its own UI) instead of the API's real TaxType code ("OUTPUT2") slips
// through and gets rejected the next time an invoice is pushed.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  try {
    const [accountsResult, taxRatesResult] = await Promise.all([
      xeroRequest('accounting', 'Accounts'),
      xeroRequest('accounting', 'TaxRates'),
    ]);

    const accounts = (accountsResult.Accounts || [])
      .filter(a => a.Status === 'ACTIVE')
      .map(a => ({ code: a.Code, name: a.Name, type: a.Type }))
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

    const taxRates = (taxRatesResult.TaxRates || [])
      .filter(t => t.Status === 'ACTIVE')
      .map(t => ({ name: t.Name, taxType: t.TaxType }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { statusCode: 200, body: JSON.stringify({ ok: true, accounts, taxRates }) };
  } catch (err) {
    console.error('get-xero-chart-of-accounts error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
