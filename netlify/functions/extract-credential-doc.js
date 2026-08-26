// POST /.netlify/functions/extract-credential-doc
// Body: { fileBase64, mediaType } - mediaType e.g. 'application/pdf',
// 'image/jpeg', 'image/png'
// Any active logged-in user - covers both an admin adding a company
// insurance policy and a staff member uploading their own licence
// certificate from the Team page. Sends the certificate/licence document to
// Claude and asks for what it's for, its reference number, and its expiry
// date. Extraction only - nothing gets saved here, the review/confirm
// screen is a separate step since a scanned certificate won't always read
// perfectly.

const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { getIntegrationKey } = require('./_shared/get-integration-key');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
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

    const prompt = `This is either an insurance Certificate of Currency or a professional/trade licence document, for an electrical/solar contracting business or one of its staff. Extract the following as accurately as possible:

- credential_type: either "insurance" or "licence" - "insurance" for a Certificate of Currency or policy schedule, "licence" for a trade/contractor/professional licence, registration, or membership certificate
- name: a short descriptive name for what this covers, e.g. "Public Liability Insurance", "Professional Indemnity Insurance", "Workers Compensation Insurance", "QLD Electrical Contractor Licence", "Master Electricians Membership" - infer a sensible name from the document even if it doesn't use these exact words
- provider: the insurer's name (for insurance) or the issuing/licensing body (for a licence)
- reference_number: the policy number (insurance) or licence/registration/membership number (licence)
- expiry_date: the expiry / renewal-due date as YYYY-MM-DD. For insurance this is usually labelled "Period of Insurance" (use the end date) or "Expiry Date". For a licence it's usually labelled "Expiry Date" or "Valid Until".

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
        max_tokens: 1000,
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
