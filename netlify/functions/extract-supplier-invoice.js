// POST /api/extract-supplier-invoice
// Body: { fileBase64, mediaType } - mediaType e.g. 'application/pdf',
// 'image/jpeg', 'image/png'
// Pricing roles only. Sends the actual supplier invoice/bill (photo or
// PDF) to Claude and asks for a structured extraction - supplier name,
// bill number, date, and every line item with quantity and unit cost.
// The reading itself lives in _shared/supplier-invoice-ai.js, shared with
// the invoice@ bill intake. This is extraction only - nothing gets saved here. The review/confirm
// screen is a separate, deliberate step, since extraction from a real
// scanned invoice is never going to be perfect every time.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { extractSupplierInvoice } = require('./_shared/supplier-invoice-ai');

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

    const extracted = await extractSupplierInvoice({ fileBase64, mediaType });

    return { statusCode: 200, body: JSON.stringify({ ok: true, extracted }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
