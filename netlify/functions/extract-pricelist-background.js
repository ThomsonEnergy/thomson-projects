// POST /.netlify/functions/extract-pricelist-background
// Body: { jobId, fileBase64, mediaType }
//
// Netlify Background Functions always return 202 immediately regardless
// of what the handler does, and can keep running for up to 15 minutes -
// unlike a normal function's ~10 second ceiling, which a long price list
// (potentially many pages, many items) could genuinely exceed. The
// frontend creates the job row itself first, calls this, then polls that
// row for the result rather than waiting on this request's response.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const ai = require('./_shared/price-list-ai');

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

    // Shared reader: PDFs a few pages at a time, and a reply cut off by the size limit is
    // read again as two halves (the old single 8000-token call failed on long lists with
    // "Unterminated string in JSON").
    const usage = { input_tokens: 0, output_tokens: 0 };
    const extracted = await ai.readWholeDocument({ fileBase64, mediaType, usage });
    if (!extracted.items.length && !extracted.is_price_list) {
      throw new Error('This does not look like a price list: no priced items were found.');
    }

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
