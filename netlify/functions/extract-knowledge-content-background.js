const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { getAdminClient } = require('./_shared/require-admin');

// Background twin of extract-knowledge-content.js - same extraction logic,
// but run async (Netlify gives background functions up to 15 minutes,
// instead of the ~10s a normal synchronous function gets) and the result
// is written straight to the knowledge_entries row instead of returned in
// a response body, since Netlify replies 202 to a background function
// immediately and doesn't wait for it to finish. Needed because a slow
// third-party PDF host plus the Claude transcription call routinely blew
// past the synchronous timeout and came back as a 504 - caught while
// bulk-importing a real knowledge base export.

const MAX_WEBSITE_CHARS = 20000;

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

async function extractDocumentOrImage(buffer, mediaType, apiKey) {
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
      max_tokens: 4000,
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

async function extractWebsite(sourceUrl) {
  const res = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThomsonProjectsBot/1.0)' } });
  if (!res.ok) throw new Error(`Couldn't fetch that page (${res.status})`);

  const contentType = res.headers.get('content-type') || '';
  const looksLikePdf = contentType.includes('application/pdf') || /\.pdf(\?|$)/i.test(sourceUrl);
  if (looksLikePdf) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const apiKey = await getIntegrationKey('anthropic');
    return extractDocumentOrImage(buffer, 'application/pdf', apiKey);
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
  try {
    const body = JSON.parse(event.body || '{}');
    entryId = body.entry_id;
    const { source_url, file_path, file_name } = body;
    if (!entryId) return { statusCode: 202, body: '' };

    let content;
    if (source_url) {
      content = await extractWebsite(source_url);
    } else if (file_path && file_name) {
      const { data, error } = await supabaseAdmin.storage.from('knowledge-files').download(file_path);
      if (error || !data) throw new Error(error?.message || 'Could not download the uploaded file');
      const buffer = Buffer.from(await data.arrayBuffer());
      const ext = (file_name.split('.').pop() || '').toLowerCase();
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        content = extractSpreadsheet(buffer);
      } else if (ext === 'txt') {
        content = buffer.toString('utf-8');
      } else {
        const mediaType = mimeFor(file_name);
        if (!mediaType) throw new Error(`Don't know how to read a .${ext} file.`);
        const apiKey = await getIntegrationKey('anthropic');
        content = await extractDocumentOrImage(buffer, mediaType, apiKey);
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
