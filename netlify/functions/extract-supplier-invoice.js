// POST /api/extract-supplier-invoice
// Body: { fileBase64, mediaType } - mediaType e.g. 'application/pdf',
// 'image/jpeg', 'image/png'
// Pricing roles only. Sends the actual supplier invoice/bill (photo or
// PDF) to Claude and asks for a structured extraction - supplier name,
// bill number, date, and every line item with quantity and unit cost.
// This is extraction only - nothing gets saved here. The review/confirm
// screen is a separate, deliberate step, since extraction from a real
// scanned invoice is never going to be perfect every time.

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

    const prompt = `This is a supplier invoice or bill for an electrical/solar contracting business. Extract the following as accurately as possible:

- supplier: the supplier/vendor's business name
- our_account_number: the account number THIS SUPPLIER uses to identify US as their customer - often labelled "Charge To", "Customer Account", "Account No", "Customer No", or similar, shown near the billing address. This is NOT their ABN and NOT their own bank details - it's specifically the number that identifies our account with them. Null if not shown.
- abn: the supplier's own ABN, if shown
- contact_phone: the supplier's phone number, if shown
- contact_email: the supplier's email address, if shown
- bank_account_name: the account name for paying them by bank transfer, if shown
- bsb: their BSB, if shown
- bank_account_number: their bank account number, if shown
- bill_number: their invoice or bill number
- bill_date: the invoice date, as YYYY-MM-DD
- line_items: an array of every line item, each with:
  - description: the item/material description as written
  - quantity: numeric quantity (default to 1 if not shown)
  - unit_cost: the cost per unit, ex-GST if both are shown, as a plain number (no currency symbols)
- subtotal: the subtotal before GST, as a plain number
- gst: the GST amount, as a plain number
- total: the total amount, as a plain number

If a field genuinely isn't visible or determinable, use null rather than guessing. Respond with ONLY a JSON object, no other text, no markdown fences.`;

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
        max_tokens: 2000,
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
