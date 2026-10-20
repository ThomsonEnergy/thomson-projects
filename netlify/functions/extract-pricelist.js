// POST /api/extract-pricelist
// Body: { fileBase64, mediaType }
// Pricing roles only. A pricelist is structurally different from a bill -
// no total to pay, no single date, just a (potentially long) list of
// items and their current prices. Kept as a separate function from the
// bill extraction rather than overloading one prompt to handle both
// shapes well.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const ai = require('./_shared/price-list-ai');

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

    // Shared reader: PDFs a few pages at a time, and a reply cut off by the size limit is
    // read again as two halves (the old single 8000-token call failed on long lists with
    // "Unterminated string in JSON").
    const usage = { input_tokens: 0, output_tokens: 0 };
    const extracted = await ai.readWholeDocument({ fileBase64, mediaType, usage });
    if (!extracted.items.length && !extracted.is_price_list) {
      throw new Error('This does not look like a price list: no priced items were found.');
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, supplier: extracted.supplier || null, items: extracted.items || [] }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
