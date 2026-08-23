// POST /api/extract-statement
// Body: { fileBase64, mediaType }
// Pricing roles only. A supplier statement lists their invoices and a
// running balance - this extracts that list so it can be reconciled
// against our own supplier_bills records for the same supplier.

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

    const prompt = `This is a supplier account statement for an electrical/solar contracting business - a summary of invoices and the current balance owed, not a single bill.

Extract:
- supplier: the supplier/vendor's business name shown on the statement
- statement_date: the date the statement was issued, as YYYY-MM-DD
- total_amount: the closing/total balance owed, as a plain number
- invoices: an array of every individual invoice/bill line shown on the statement, each with:
  - bill_number: their invoice number as shown
  - amount: the amount for that invoice, as a plain number
  - date: that invoice's own date if shown, as YYYY-MM-DD, otherwise null

If a field genuinely isn't visible, use null rather than guessing. Respond with ONLY a JSON object, no other text, no markdown fences.`;

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
        max_tokens: 4000,
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

    return { statusCode: 200, body: JSON.stringify({ ok: true, extracted }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
