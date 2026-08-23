// POST /.netlify/functions/extract-statement-background
// Body: { jobId, fileBase64, mediaType }
// Same background-job pattern as extract-pricelist-background.js - a
// multi-page statement can take longer than a normal function allows.

const fetch = require('node-fetch');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { getIntegrationKey } = require('./_shared/get-integration-key');

exports.handler = async (event) => {
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: '' };
  const { supabaseAdmin } = auth;

  const { jobId, filePath, mediaType } = JSON.parse(event.body || '{}');

  try {
    const { data: fileBlob, error: downloadErr } = await supabaseAdmin.storage.from('project-documents').download(filePath);
    if (downloadErr) throw downloadErr;
    const fileBase64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64');

    const apiKey = await getIntegrationKey('anthropic');
    const isPdf = mediaType === 'application/pdf';

    const prompt = `This is a supplier account statement for an electrical/solar contracting business - a summary of invoices and the current balance owed, not a single bill.

Extract:
- supplier: the supplier/vendor's business name shown on the statement
- abn: the supplier's ABN, if shown
- acn: the supplier's ACN, if shown
- contact_email: an email address for the supplier, if shown
- contact_phone: a phone number for the supplier, if shown
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

    await supabaseAdmin.from('ai_extraction_jobs').update({
      status: 'complete', result: extracted,
    }).eq('id', jobId);
  } catch (err) {
    console.error(err);
    await supabaseAdmin.from('ai_extraction_jobs').update({
      status: 'failed', error: err.message,
    }).eq('id', jobId);
  }
};
