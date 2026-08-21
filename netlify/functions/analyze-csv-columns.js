// POST /api/analyze-csv-columns
// Body: { headers: [...], sampleRows: [{...}, ...] }
// Uses the Anthropic API to work out which CSV column is which (name,
// email, phone, address) - handles arbitrary, oddly-named, or combined
// columns (e.g. "Full Name" vs separate "First"/"Last", "Contact" vs
// "Company") better than a fixed keyword-matching guess ever could,
// since it can look at the actual sample values too, not just headers.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { headers, sampleRows } = JSON.parse(event.body || '{}');
    if (!Array.isArray(headers) || !headers.length) {
      return { statusCode: 400, body: 'headers is required' };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const prompt = `You're helping map a client-list spreadsheet's columns onto a fixed set of fields for an electrical contracting business's client database.

The columns in this file, in order: ${headers.join(', ')}

Here are a few sample rows (as JSON) to help you judge what each column actually contains:
${JSON.stringify(sampleRows, null, 2)}

Map each of these target fields to the single best-matching column name from the list above, or null if nothing in the file matches:
- name (the client's name - a person's full name, or a company/business name; if the file has separate First/Last name columns instead of one combined name column, pick the one that seems most complete, or note both aren't needed since only one field exists)
- email
- phone
- address (a single combined address field, if one exists - don't worry about matching multiple separate address-part columns)

Respond with ONLY a JSON object, no other text, no markdown fences, using the exact column names from the list above (or null). Example shape:
{"name": "Company Name", "email": "Email Address", "phone": "Mobile", "address": null}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    const cleaned = raw.replace(/^```json/i, '').replace(/```$/, '').trim();
    const mapping = JSON.parse(cleaned);

    return { statusCode: 200, body: JSON.stringify({ ok: true, mapping }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
