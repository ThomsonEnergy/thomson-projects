// POST /.netlify/functions/extract-statement-background
// Body: { jobId, fileBase64, mediaType }
// Same background-job pattern as extract-pricelist-background.js - a
// multi-page statement can take longer than a normal function allows.
// The reading itself lives in _shared/statement-ai.js, shared with emailed statements.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { extractStatement } = require('./_shared/statement-ai');

exports.handler = async (event) => {
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: '' };
  const { supabaseAdmin } = auth;

  const { jobId, filePath, mediaType } = JSON.parse(event.body || '{}');

  try {
    const { data: fileBlob, error: downloadErr } = await supabaseAdmin.storage.from('project-documents').download(filePath);
    if (downloadErr) throw downloadErr;
    const fileBase64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64');

    const { extracted } = await extractStatement({ fileBase64, mediaType });

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
