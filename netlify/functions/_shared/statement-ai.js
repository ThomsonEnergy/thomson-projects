// Reads a supplier account statement (PDF or photo) with Claude. Shared by the manual upload
// (extract-statement-background.js) and emailed statements (_shared/statement-intake.js).
// Returns { extracted, usage }. Extraction only: nothing is saved here.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

async function extractStatement({ fileBase64, mediaType }) {
  const apiKey = await getIntegrationKey('anthropic');
  const isPdf = mediaType === 'application/pdf';

  const prompt = `This is a supplier account statement for an electrical/solar contracting business - a summary of invoices and the current balance owed, not a single bill.

Extract:
- is_statement: true if this really is an account statement, false if it is something else (a single invoice, a price list, a remittance, a flyer)
- supplier: the supplier/vendor's business name shown on the statement
- abn: the supplier's ABN, if shown
- acn: the supplier's ACN, if shown
- our_account_number: our account/customer number with them, if shown
- contact_email: an email address for the supplier, if shown
- contact_phone: a phone number for the supplier, if shown
- statement_date: the date the statement was issued, as YYYY-MM-DD
- total_amount: the closing/total balance owed, as a plain number
- invoices: an array of every line shown on the statement (invoices, credit notes and payments), each with:
  - bill_number: their invoice / credit note / payment reference as shown
  - amount: the amount for that line, as a plain number (credits and payments as positive numbers)
  - date: that line's own date if shown, as YYYY-MM-DD, otherwise null
  - type: "invoice", "credit" or "payment"

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
  return { extracted: JSON.parse(cleaned), usage: data.usage || {} };
}

module.exports = { extractStatement };
