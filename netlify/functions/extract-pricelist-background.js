// POST /.netlify/functions/extract-pricelist-background
// Body: { jobId, fileBase64, mediaType }
//
// Netlify Background Functions always return 202 immediately regardless
// of what the handler does, and can keep running for up to 15 minutes -
// unlike a normal function's ~10 second ceiling, which a long price list
// (potentially many pages, many items) could genuinely exceed. The
// frontend creates the job row itself first, calls this, then polls that
// row for the result rather than waiting on this request's response.

const fetch = require('node-fetch');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { getIntegrationKey } = require('./_shared/get-integration-key');

exports.handler = async (event) => {
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: '' }; // response body is discarded anyway for background functions
  const { supabaseAdmin } = auth;

  const { jobId, filePath, mediaType } = JSON.parse(event.body || '{}');

  try {
    // The file was uploaded to storage by the client first - only the
    // path travels through this invocation, since Background Function
    // payloads are capped at 256KB, far too small for an encoded PDF.
    const { data: fileBlob, error: downloadErr } = await supabaseAdmin.storage.from('project-documents').download(filePath);
    if (downloadErr) throw downloadErr;
    const fileBase64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64');

    const apiKey = await getIntegrationKey('anthropic');
    const isPdf = mediaType === 'application/pdf';

    const prompt = `This is a supplier price list for an electrical/solar contracting business - potentially many items, not a bill to be paid. Extract:

- supplier: the supplier/vendor's business name shown on the document
- items: an array, each with:
  - description: the item/product name or description as written
  - unit_cost: the price per unit, ex-GST if both are shown, as a plain number (no currency symbols)
  - part_number: their part/SKU number if shown, otherwise null

Extract every item on the list, however many there are - don't stop early or summarize. If a price genuinely isn't legible for an item, use null for unit_cost rather than guessing.

Respond with ONLY a JSON object shaped like {"supplier": "...", "items": [...]}, no other text, no markdown fences.`;

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

    await supabaseAdmin.from('ai_extraction_jobs').update({
      status: 'complete',
      result: { supplier: extracted.supplier || null, items: extracted.items || [] },
    }).eq('id', jobId);
  } catch (err) {
    console.error(err);
    await supabaseAdmin.from('ai_extraction_jobs').update({
      status: 'failed', error: err.message,
    }).eq('id', jobId);
  }
};
