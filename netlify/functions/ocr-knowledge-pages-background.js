// POST /.netlify/functions/ocr-knowledge-pages-background
// Body: { entry_id, pages: [{ n, path }] }  - path is a page image the
// browser already rendered and uploaded to the knowledge-files bucket.
//
// Background function (a vision read of a few dense table pages takes well
// over a normal function's ~10s). Transcribes the given pages with Claude
// and writes the result as one row in knowledge_ocr_parts; the browser
// (public/knowledge.html, "Read with OCR") polls for it and stitches all
// the batches together. Images travel via storage rather than the request
// body because a background function's payload is capped at ~256KB.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requireActiveUser } = require('./_shared/require-active-user');

const PROMPT = (first, last) => `These are pages ${first} to ${last} of an Australian electrical standard (AS/NZS), as images. Transcribe every page exactly as printed, in plain text, for a searchable knowledge base.
- Start each page with a line "--- Page N ---" using the page numbers given before each image.
- Reproduce every table as plain text: the table number and title, then the column headings, then one row per line with cells separated by " | ". Keep every number exactly as printed, with its units and any footnote markers.
- Keep clause numbers, headings, lists and notes.
- If something is genuinely unreadable write [unclear] in its place. Never guess, correct, round or fill in a value that isn't legible.
- No commentary, no summary, just the transcription.`;

exports.handler = async (event) => {
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 202, body: '' };
  const { supabaseAdmin } = auth;

  let entryId, pages = [];
  try {
    const body = JSON.parse(event.body || '{}');
    entryId = body.entry_id;
    pages = Array.isArray(body.pages) ? body.pages : [];
  } catch { return { statusCode: 202, body: '' }; }
  if (!entryId || !pages.length) return { statusCode: 202, body: '' };

  const first = pages[0].n;
  const last = pages[pages.length - 1].n;
  const paths = pages.map(p => p.path).filter(Boolean);
  const saveResult = (text, error) =>
    supabaseAdmin.from('knowledge_ocr_parts').insert({ entry_id: entryId, start_page: first, end_page: last, text: text || null, error: error || null });

  try {
    const content = [{ type: 'text', text: PROMPT(first, last) }];
    for (const p of pages) {
      const { data, error } = await supabaseAdmin.storage.from('knowledge-files').download(p.path);
      if (error || !data) throw new Error(`Couldn't load the image for page ${p.n}`);
      const base64 = Buffer.from(await data.arrayBuffer()).toString('base64');
      content.push({ type: 'text', text: `Page ${p.n}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
    }

    const apiKey = await getIntegrationKey('anthropic');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 12000, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    const text = data.content.map(b => b.text || '').join('').trim();
    if (!text) throw new Error('Nothing came back for these pages.');
    if (data.stop_reason === 'max_tokens') {
      await saveResult(`${text}\n[The end of pages ${first}-${last} was cut off - re-read these pages on their own to get the rest.]`, null);
    } else {
      await saveResult(text, null);
    }
  } catch (err) {
    console.error('ocr-knowledge-pages-background failed:', err.message);
    await saveResult(null, err.message).then(() => {}, () => {});
  } finally {
    if (paths.length) await supabaseAdmin.storage.from('knowledge-files').remove(paths).then(() => {}, () => {});
  }
  return { statusCode: 202, body: '' };
};
