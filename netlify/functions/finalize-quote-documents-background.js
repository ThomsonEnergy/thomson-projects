// POST /.netlify/functions/finalize-quote-documents-background
// Body: { kind: 'variation_signed', variationId } or { kind: 'quote_accepted', quoteId, jobId }
//
// Background function (the PDFs take a while). It only does bookkeeping; the PDFs themselves are made
// by generate-client-document-pdf.js, which it calls over HTTP (that function has the memory Chromium
// needs). Started by accept-variation.js and accept-quote.js right after a client signs.
//
// The job's quote PDF is always the current one:
//   quote_accepted    the signed quote becomes the job's quote PDF.
//   variation_signed  1. the quote PDF the job had until now is filed as a legacy document
//                        ("Original signed quote", or "Quote before Variation N");
//                     2. the signed variation gets its own PDF (original quote + variation + signature),
//                        filed in the Variations folder;
//                     3. the job's quote PDF is made again, now including every approved variation.
// Documents show up in the job's Documents tab. Nothing is overwritten: a legacy copy is a copy.

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { selfBaseUrl } = require('./_shared/site-url');
const { requireInternal, internalHeaders } = require('./_shared/require-internal');

async function makePdf(docType, recordId) {
  const res = await fetch(`${selfBaseUrl()}/.netlify/functions/generate-client-document-pdf`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ doc_type: docType, record_id: recordId }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error(`PDF function answered ${res.status}`); }
  if (!res.ok || !data.ok) throw new Error(data.error || `PDF function answered ${res.status}`);
  return data.path;
}

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

async function addDocument(supabaseAdmin, projectId, folder, filePath, fileName) {
  await supabaseAdmin.from('project_documents').delete().eq('project_id', projectId).eq('file_path', filePath);
  const { error } = await supabaseAdmin.from('project_documents').insert({ project_id: projectId, folder, file_path: filePath, file_name: fileName, mime_type: 'application/pdf' });
  if (error) throw error;
}

async function variationSigned(supabaseAdmin, variationId) {
  const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('*').eq('id', variationId).maybeSingle();
  if (!entry || entry.approval_status !== 'approved') return;
  // only ever once per variation, however many times this is called
  if (entry.documents_finalized_at) return;
  const { error: claimErr, data: claimed } = await supabaseAdmin.from('job_variation_entries')
    .update({ documents_finalized_at: new Date().toISOString() }).eq('id', variationId).is('documents_finalized_at', null).select('id');
  if (claimErr || !claimed || !claimed.length) return;

  const { data: job } = await supabaseAdmin.from('projects').select('id, name, job_number, quote_number, quote_pdf_path, source_quote_id').eq('id', entry.project_id).single();
  const { data: source } = job.source_quote_id
    ? await supabaseAdmin.from('projects').select('quote_number, quote_pdf_path').eq('id', job.source_quote_id).maybeSingle()
    : { data: null };
  const qNo = (source && source.quote_number) || job.quote_number;
  const qLabel = qNo ? `Q${qNo}` : 'quote';
  const number = entry.variation_number || 1;

  // 1. file the quote PDF the job has had until now as a legacy document
  try {
    const current = job.quote_pdf_path || (source && source.quote_pdf_path);
    if (current) {
      const { count: earlier } = await supabaseAdmin.from('job_variation_entries').select('id', { count: 'exact', head: true })
        .eq('project_id', job.id).eq('variation_type', 'fixed').eq('approval_status', 'approved').neq('id', entry.id);
      const legacyName = earlier > 0 ? `Quote ${qLabel} before Variation ${number} (legacy)` : `Original signed quote ${qLabel} (legacy)`;
      const dest = `client-documents/legacy/${job.id}/${Date.now()}-${safe(legacyName)}.pdf`;
      const { error: copyErr } = await supabaseAdmin.storage.from('project-documents').copy(current, dest);
      if (copyErr) throw copyErr;
      await addDocument(supabaseAdmin, job.id, 'Legacy quotes', dest, `${legacyName}.pdf`);
    }
  } catch (err) {
    console.error('legacy quote copy failed:', err.message);
  }

  // 2. the signed variation's own PDF
  try {
    const path = await makePdf('variation', entry.id);
    await addDocument(supabaseAdmin, job.id, 'Variations', path, `Variation ${number} - ${safe(entry.description)} (signed).pdf`);
  } catch (err) {
    console.error('variation PDF failed:', err.message);
  }

  // 3. the job's current quote PDF, now with every approved variation in it
  try {
    await makePdf('quote', job.id);
  } catch (err) {
    console.error('current quote PDF failed:', err.message);
    await supabaseAdmin.from('projects').update({ quote_pdf_error: `Could not refresh the quote PDF after Variation ${number} was signed: ${err.message}` }).eq('id', job.id);
  }
}

async function quoteAccepted(supabaseAdmin, quoteId, jobId) {
  // the PDF only ever goes onto the job that was made from this quote
  if (jobId) {
    const { data: job } = await supabaseAdmin.from('projects').select('id, source_quote_id').eq('id', jobId).maybeSingle();
    if (!job || job.source_quote_id !== quoteId) throw new Error(`job ${jobId} was not made from quote ${quoteId}`);
  }
  const path = await makePdf('quote', quoteId); // the signed, accepted quote
  if (!jobId) return;
  const dest = `client-documents/quotes/${jobId}.pdf`;
  const { error: copyErr } = await supabaseAdmin.storage.from('project-documents').copy(path, dest);
  if (copyErr) {
    // an older copy is in the way: replace it
    await supabaseAdmin.storage.from('project-documents').remove([dest]);
    const { error: retryErr } = await supabaseAdmin.storage.from('project-documents').copy(path, dest);
    if (retryErr) throw retryErr;
  }
  await supabaseAdmin.from('projects').update({ quote_pdf_path: dest, quote_pdf_generated_at: new Date().toISOString(), quote_pdf_error: null }).eq('id', jobId);
}

exports.handler = async (event) => {
  // only accept-quote and accept-variation start this (x-internal-secret, _shared/start-finalize-documents.js)
  if (!requireInternal(event)) {
    console.error('finalize-quote-documents-background: refused, no internal secret');
    return { statusCode: 202, body: '' };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const supabaseAdmin = getAdminClient();
    if (body.kind === 'variation_signed' && body.variationId) await variationSigned(supabaseAdmin, body.variationId);
    else if (body.kind === 'quote_accepted' && body.quoteId) await quoteAccepted(supabaseAdmin, body.quoteId, body.jobId || null);
  } catch (err) {
    console.error('finalize-quote-documents-background failed:', err.message);
  }
  return { statusCode: 202, body: '' };
};
