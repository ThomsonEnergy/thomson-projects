// POST /api/extract-statement
// Body: { fileBase64, mediaType }
// Pricing roles only. A supplier statement lists their invoices and a
// running balance - this extracts that list so it can be reconciled
// against our own supplier_bills records for the same supplier.
// The reading itself is the shared reader (_shared/statement-ai.js), the same one the
// Suppliers page and emailed statements use: every line comes back with a type (invoice,
// credit or payment), so payments are never reconciled as missing invoices.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { extractStatement } = require('./_shared/statement-ai');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  try {
    const { fileBase64, mediaType } = JSON.parse(event.body || '{}');
    if (!fileBase64 || !mediaType) {
      return { statusCode: 400, body: JSON.stringify({ error: 'fileBase64 and mediaType are required' }) };
    }

    const { extracted } = await extractStatement({ fileBase64, mediaType });
    if (extracted && extracted.is_statement === false) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'This does not look like a supplier statement (a single invoice, a price list or a remittance?). Upload bills from the Bills section instead.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, extracted }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
