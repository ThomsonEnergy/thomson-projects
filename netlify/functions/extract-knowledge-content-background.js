const fetch = require('node-fetch');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requireActiveUser } = require('./_shared/require-active-user');
const { claudeJson } = require('./_shared/claude-json');

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
// A pasted link is fetched from the server, so it is kept on a short leash: https only, public
// addresses only (checked again on every redirect, at most 5), 20 seconds and 5 MB.
const MAX_WEBSITE_BYTES = 5 * 1024 * 1024;
const WEBSITE_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;

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
    body: claudeJson({
      model: 'claude-sonnet-5-5',
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
async function handlePdf(buffer, apiKey, onProgress, meta = {}) {
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
  meta.pageCount = pageCount;
  meta.textChars = text.length;
  if (looksLikeRealText) return text;

  return transcribeScannedPdf(buffer, apiKey, onProgress);
}

// Addresses a staff-typed link must never reach from the server: this machine, the private
// ranges, link-local (cloud metadata lives at 169.254.169.254), carrier NAT, multicast and
// reserved space. Anything that is not an address at all is refused too.
function isPrivateAddress(ip) {
  let a = String(ip || '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7); // an IPv4 address written as IPv6
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  return true;
}

// The link is checked before it is opened: https only, and the host must resolve to public
// addresses. Returns the parsed URL and the addresses it resolved to.
async function checkWebsiteUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error('That is not a valid web address.'); }
  if (url.protocol !== 'https:') throw new Error('Only https:// links can be read.');
  if (url.username || url.password) throw new Error('Links with a login in them cannot be read.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) throw new Error('That address is not a public website.');
  let addresses;
  try { addresses = await dns.lookup(host, { all: true }); } catch (e) { throw new Error(`Couldn't find that website (${host}).`); }
  if (!addresses.length || addresses.some((x) => isPrivateAddress(x.address))) throw new Error('That address is not a public website.');
  return { url, addresses };
}

// The connection goes to the addresses that were checked, not to a second lookup of the name.
function pinnedAgent(addresses) {
  return new https.Agent({
    lookup: (hostname, options, cb) => {
      if (options && options.all) return cb(null, addresses.map((x) => ({ address: x.address, family: x.family })));
      return cb(null, addresses[0].address, addresses[0].family);
    },
  });
}

function websiteFetchError(err) {
  if (err && err.type === 'max-size') return new Error('That page is over 5 MB, so it was not read.');
  if (err && (err.type === 'request-timeout' || err.type === 'body-timeout')) return new Error('That page took over 20 seconds to load, so it was not read.');
  return err;
}

async function extractWebsite(sourceUrl, apiKeyGetter, onProgress) {
  let { url, addresses } = await checkWebsiteUrl(sourceUrl);
  let res;
  for (let hop = 0; ; hop += 1) {
    try {
      res = await fetch(url.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThomsonProjectsBot/1.0)' },
        redirect: 'manual', timeout: WEBSITE_TIMEOUT_MS, size: MAX_WEBSITE_BYTES, agent: pinnedAgent(addresses),
      });
    } catch (err) {
      throw websiteFetchError(err);
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get('location');
    if (!location) throw new Error(`Couldn't fetch that page (${res.status})`);
    if (hop >= MAX_REDIRECTS) throw new Error('That link redirects too many times.');
    let next;
    try { next = new URL(location, url).href; } catch (e) { throw new Error('That link redirects to an invalid address.'); }
    ({ url, addresses } = await checkWebsiteUrl(next));
  }
  if (!res.ok) throw new Error(`Couldn't fetch that page (${res.status})`);
  if (Number(res.headers.get('content-length')) > MAX_WEBSITE_BYTES) throw new Error('That page is over 5 MB, so it was not read.');

  const contentType = res.headers.get('content-type') || '';
  const looksLikePdf = contentType.includes('application/pdf') || /\.pdf$/i.test(url.pathname);
  let body;
  try {
    body = looksLikePdf ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } catch (err) {
    throw websiteFetchError(err);
  }
  if (looksLikePdf) {
    const apiKey = await apiKeyGetter();
    return handlePdf(body, apiKey, onProgress);
  }

  const text = stripHtml(body).slice(0, MAX_WEBSITE_CHARS);
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
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 202, body: '' };
  const { supabaseAdmin } = auth;
  let entryId;
  let readWarning = null;
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
        const meta = {};
        content = await handlePdf(buffer, apiKey, saveProgress, meta);
        // A real standard runs thousands of characters a page. Far less means
        // only some pages had readable text (e.g. tables in fonts with no text
        // mapping) - say so rather than quietly storing a fraction of it.
        if (meta.pageCount > 5 && meta.textChars / meta.pageCount < 400) {
          readWarning = `Only ${meta.textChars} characters were readable across ${meta.pageCount} pages - some pages (often tables) probably couldn't be read. Use Read again on the Knowledge page to read them page by page.`;
        }
      } else {
        const mediaType = mimeFor(file_name);
        if (!mediaType) throw new Error(`Don't know how to read a .${ext} file.`);
        const apiKey = await getIntegrationKey('anthropic');
        content = await extractDocumentOrImage(buffer, mediaType, apiKey, 4000);
      }
    } else {
      return { statusCode: 202, body: '' };
    }

    await supabaseAdmin.from('knowledge_entries').update({ content, extraction_error: readWarning }).eq('id', entryId);
  } catch (err) {
    console.error('background extraction failed:', err);
    if (entryId) {
      await supabaseAdmin.from('knowledge_entries').update({ extraction_error: err.message }).eq('id', entryId).then(() => {}, () => {});
    }
  }
  return { statusCode: 202, body: '' };
};
