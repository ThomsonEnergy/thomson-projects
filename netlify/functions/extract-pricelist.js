// POST /api/extract-pricelist
// Body: { fileBase64, mediaType }
// Pricing roles only. A pricelist is structurally different from a bill -
// no total to pay, no single date, just a (potentially long) list of
// items and their current prices. Kept as a separate function from the
// bill extraction rather than overloading one prompt to handle both
// shapes well.

const fetch = require('node-fetch');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { getIntegrationKey } = require('./_shared/get-integration-key');

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

    const apiKey = await getIntegrationKey('anthropic');
    const isPdf = mediaType === 'application/pdf';

    const prompt = `This is a supplier price list for an electrical/solar contracting business - potentially many items, not a bill to be paid. Extract every item you can find:

- items: an array, each with:
  - description: the item/product name or description as written
  - unit_cost: the price per unit, ex-GST if both are shown, as a plain number (no currency symbols)
  - part_number: their part/SKU number if shown, otherwise null

Extract every item on the list, however many there are - don't stop early or summarize. If a price genuinely isn't legible for an item, use null for unit_cost rather than guessing.

Respond with ONLY a JSON object shaped like {"items": [...]}, no other text, no markdown fences.`;

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [contentBlock, { type: 'text', text: prompt }],
        }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    const cleaned = raw.replace(/^```json/i, '').replace(/```$/, '').trim();
    const extracted = JSON.parse(cleaned);

    return { statusCode: 200, body: JSON.stringify({ ok: true, items: extracted.items || [] }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
