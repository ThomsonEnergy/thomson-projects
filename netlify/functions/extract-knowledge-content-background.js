const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { getAdminClient } = require('./_shared/require-admin');

// Reads whatever a staff member added to the Knowledge Base - a pasted
// website URL, or an uploaded PDF/image/spreadsheet - into plain
// searchable text. Runs as a Netlify background function (up to 15
// minutes, instead of the ~10s a normal synchronous function gets) and
// writes the result straight onto the knowledge_entries row instead of
// returning it in a response body, since Netlify replies 202 to a
// background function immediately and doesn't wait for it to finish.
// Needed because a slow third-party PDF host plus the Claude
// transcription call routinely blew past a synchronous timeout and came
// back as a 504 - caught while bulk-importing a real knowledge base
// export.

const MAX_WEBSITE_CHARS = 20000;

// Anthropic caps a single request at 600 PDF pages, and even well under
// that, asking for a full verbatim transcription of a big multi-hundred-
// page document in one response blows past any reasonable max_tokens.
// Found for real: someone uploaded the actual AS/NZS 3000 standard, which
// errored with "A maximum of 600 PDF pages may be provided." So a large
// PDF gets split into page-range sub-documents and transcribed chunk by
// chunk, writing the growing result back after every chunk - if the
// function does eventually run out of its 15-minute budget, whatever's
// been transcribed so far is still saved instead of nothing at all.
const MAX_PAGES_PER_CHUNK = 15;
const MAX_TOTAL_PAGES = 1500;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mimeFor(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

async function extractDocumentOrImage(buffer, mediaType, apiKey, maxTokens) {
  const base64 = buffer.toString('base64');
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const promptText = 'Transcribe the full text content of this document/image into plain text, as completely and accurately as possible - headings, body text, lists, table contents, labels, numbers, standard clause references, everything readable. This is going into an internal knowledge base search index, so completeness matters more than tidiness. No commentary, just the transcription.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens || 4000,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }, block] }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('').trim();
}

// Transcribes a PDF via Claude vision, splitting into page-range chunks
// once it exceeds one chunk's worth of pages. This is the fallback path
// for a scanned/image-only PDF with no real text layer - see handlePdf()
// below, which tries actual text extraction first and only reaches this
// for a document that genuinely needs OCR. Re-serializing pages this way
// via pdf-lib does NOT properly decrypt a PDF that uses standard
// encryption (pdf-lib's `ignoreEncryption` loads the structure but not the
// content), so an encrypted scanned document will still come out blank -
// a rarer combination than plain encryption, which handlePdf's text-first
// path already handles correctly.
async function transcribeScannedPdf(buffer, apiKey, onProgress) {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();

  if (pageCount > MAX_TOTAL_PAGES) {
    throw new Error(`This PDF has ${pageCount} pages - too large to transcribe automatically (cap is ${MAX_TOTAL_PAGES}). Split it into smaller files first.`);
  }
  if (pageCount <= MAX_PAGES_PER_CHUNK) {
    return extractDocumentOrImage(buffer, 'application/pdf', apiKey, 8000);
  }

  const parts = [];
  for (let start = 0; start < pageCount; start += MAX_PAGES_PER_CHUNK) {
    const end = Math.min(start + MAX_PAGES_PER_CHUNK, pageCount);
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);

    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach((p) => chunkDoc.addPage(p));
    const chunkBuffer = Buffer.from(await chunkDoc.save());

    let chunkText;
    try {
      chunkText = await extractDocumentOrImage(chunkBuffer, 'application/pdf', apiKey, 8000);
    } catch (err) {
      // One bad chunk (a scanned/blank/corrupt page range) shouldn't lose
      // everything transcribed either side of it.
      chunkText = `[Pages ${start + 1}-${end} could not be transcribed: ${err.message}]`;
    }
    parts.push(`--- Pages ${start + 1}-${end} of ${pageCount} ---\n${chunkText}`);
    if (onProgress) await onProgress(parts.join('\n\n'));
  }
  return parts.join('\n\n');
}

// A digitally-produced PDF (the overwhelming majority - including one
// that's encryption-protected against copying/printing, e.g. a purchased
// AS/NZS standard) has its real text embedded in the file. Extracting that
// directly is faster, cheaper, and far more accurate than re-rendering
// pages as images for Claude to OCR - and, importantly, pdf-parse (built
// on pdfjs-dist, the same engine browsers use to open/search a PDF)
// handles standard PDF encryption with a blank owner password
// transparently, where pdf-lib does not. Only fall back to Claude vision
// transcription for a genuinely scanned/image-only PDF with no usable
// text layer.
async function handlePdf(buffer, apiKey, onProgress) {
  let parsed = null;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    // pdf-parse itself failed to open it (e.g. malformed file) - fall
    // through to the vision path, which has its own error handling.
  }

  const text = (parsed?.text || '').trim();
  const pageCount = parsed?.numpages || 1;
  const looksLikeRealText = text.length > Math.max(200, pageCount * 10);
  if (looksLikeRealText) return text;

  return transcribeScannedPdf(buffer, apiKey, onProgress);
}

async function extractWebsite(sourceUrl, apiKeyGetter, onProgress) {
  const res = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThomsonProjectsBot/1.0)' } });
  if (!res.ok) throw new Error(`Couldn't fetch that page (${res.status})`);

  const contentType = res.headers.get('content-type') || '';
  const looksLikePdf = contentType.includes('application/pdf') || /\.pdf(\?|$)/i.test(sourceUrl);
  if (looksLikePdf) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const apiKey = await apiKeyGetter();
    return handlePdf(buffer, apiKey, onProgress);
  }

  const html = await res.text();
  const text = stripHtml(html).slice(0, MAX_WEBSITE_CHARS);
  if (!text) throw new Error("Couldn't find any readable text on that page.");
  return text;
}

function extractSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = workbook.SheetNames.map((sheetName) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    return `--- Sheet: ${sheetName} ---\n${csv}`;
  });
  return parts.join('\n\n');
}

exports.handler = async (event) => {
  const supabaseAdmin = getAdminClient();
  let entryId;
  const saveProgress = async (partialContent) => {
    await supabaseAdmin.from('knowledge_entries').update({ content: partialContent }).eq('id', entryId);
  };

  try {
    const body = JSON.parse(event.body || '{}');
    entryId = body.entry_id;
    const { source_url, file_path, file_name } = body;
    if (!entryId) return { statusCode: 202, body: '' };

    let content;
    if (source_url) {
      content = await extractWebsite(source_url, () => getIntegrationKey('anthropic'), saveProgress);
    } else if (file_path && file_name) {
      const { data, error } = await supabaseAdmin.storage.from('knowledge-files').download(file_path);
      if (error || !data) throw new Error(error?.message || 'Could not download the uploaded file');
      const buffer = Buffer.from(await data.arrayBuffer());
      const ext = (file_name.split('.').pop() || '').toLowerCase();
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        content = extractSpreadsheet(buffer);
      } else if (ext === 'txt') {
        content = buffer.toString('utf-8');
      } else if (ext === 'pdf') {
        const apiKey = await getIntegrationKey('anthropic');
        content = await handlePdf(buffer, apiKey, saveProgress);
      } else {
        const mediaType = mimeFor(file_name);
        if (!mediaType) throw new Error(`Don't know how to read a .${ext} file.`);
        const apiKey = await getIntegrationKey('anthropic');
        content = await extractDocumentOrImage(buffer, mediaType, apiKey, 4000);
      }
    } else {
      return { statusCode: 202, body: '' };
    }

    await supabaseAdmin.from('knowledge_entries').update({ content, extraction_error: null }).eq('id', entryId);
  } catch (err) {
    console.error('background extraction failed:', err);
    if (entryId) {
      await supabaseAdmin.from('knowledge_entries').update({ extraction_error: err.message }).eq('id', entryId).then(() => {}, () => {});
    }
  }
  return { statusCode: 202, body: '' };
};
