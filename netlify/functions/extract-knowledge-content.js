const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { getAdminClient } = require('./_shared/require-admin');

// Turns whatever a staff member added to the Knowledge Base - a pasted
// website URL, or an uploaded PDF/image/spreadsheet - into plain
// searchable text, so the AI chatbox can find and quote it later without
// needing to re-read the original file/page on every question. Text
// entries need no extraction (the pasted text already IS the content) and
// never reach this function.

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

async function extractWebsite(sourceUrl) {
  const res = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThomsonProjectsBot/1.0)' } });
  if (!res.ok) throw new Error(`Couldn't fetch that page (${res.status})`);
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { source_url, file_path, file_name } = JSON.parse(event.body || '{}');

    if (source_url) {
      const content = await extractWebsite(source_url);
      return { statusCode: 200, body: JSON.stringify({ ok: true, content }) };
    }

    if (!file_path || !file_name) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'source_url or file_path+file_name required' }) };
    }

    const supabaseAdmin = getAdminClient();
    const { data, error } = await supabaseAdmin.storage.from('knowledge-files').download(file_path);
    if (error || !data) throw new Error(error?.message || 'Could not download the uploaded file');
    const buffer = Buffer.from(await data.arrayBuffer());

    const ext = (file_name.split('.').pop() || '').toLowerCase();
    let content;
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      content = extractSpreadsheet(buffer);
    } else if (ext === 'txt') {
      content = buffer.toString('utf-8');
    } else {
      const mediaType = mimeFor(file_name);
      if (!mediaType) throw new Error(`Don't know how to read a .${ext} file - try a PDF, image, spreadsheet, or plain text file instead.`);
      const apiKey = await getIntegrationKey('anthropic');
      content = await extractDocumentOrImage(buffer, mediaType, apiKey);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, content }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
