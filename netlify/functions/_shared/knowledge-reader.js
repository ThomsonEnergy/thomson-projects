// Knowledge Base background reader (docs/PROJECT_SPEC.md A26, migration 20261104010000).
//
// Reads a PDF entry page by page on the server, so nobody has to keep the Knowledge page open:
//   1. the page's own text layer first (free, exact);
//   2. a page whose text layer is thin, or has a table (the AS/NZS 3008 case: table fonts with no text
//      mapping), or every page when the job's mode is 'ocr', is rendered to a picture here (pdf.js plus
//      @napi-rs/canvas, no browser) and Claude transcribes it, one page per call;
//   3. the copyright output filter blocks some word for word pages of a purchased standard ("Output blocked
//      by content filtering policy", 43 batches of AS/NZS 3000 the first time). A blocked page is tried once
//      more, then asked for as reference notes (clause numbers, requirements, table values) and marked
//      'notes'; blocked even then, it is marked 'failed' with the reason.
// Each page lands in knowledge_pages as it is read. A run works for up to RUN_BUDGET_MS, then calls the
// background function again for the rest (read-knowledge-sweep.js restarts a run that died). When the
// last page is in, kb_finish_read() stitches knowledge_entries.content and the person who queued it gets
// a phone notification.

const path = require('path');
const fetch = require('node-fetch');
const { createCanvas, DOMMatrix, Path2D, ImageData } = require('@napi-rs/canvas');
// pdf.js expects these browser globals; set before it loads so it never looks for node-canvas.
globalThis.DOMMatrix = globalThis.DOMMatrix || DOMMatrix;
globalThis.Path2D = globalThis.Path2D || Path2D;
globalThis.ImageData = globalThis.ImageData || ImageData;
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { getIntegrationKey } = require('./get-integration-key');
const { selfBaseUrl } = require('./site-url');
const { internalHeaders } = require('./require-internal');

const MODEL = 'claude-sonnet-5-5';
const RUN_BUDGET_MS = 11 * 60 * 1000; // a background function gets 15 minutes
// Pages one run reads before handing the rest to the next run (as it does when its time is up), so one
// invocation never works through a whole 600 page standard in one go and the cancel check keeps coming
// round (M21 in docs/BUG_REVIEW_2026-10-23.md).
const MAX_PAGES_PER_RUN = 150;
const LOCK_MINUTES = 14;
const LONG_EDGE_PX = 1800;
const THIN_TEXT_CHARS = 400;
const MAX_TOKENS = 6000;
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.worker.js');

const VERBATIM_PROMPT = (n) => `This is page ${n} of an Australian electrical standard or technical document, as an image. Transcribe it exactly as printed, in plain text, for a searchable knowledge base.
- Tables as plain text: the table number and title, then the column headings, then one row per line with cells separated by " | ". Keep every number exactly as printed, with its units and any footnote markers.
- Keep clause numbers, headings, lists and notes. Leave out the running page header and footer.
- Write [unclear] for anything not legible. Never guess, correct, round or fill in a value.
- No commentary, no summary, just the transcription.`;

const NOTES_PROMPT = (n) => `This is page ${n} of an Australian electrical standard or technical document, as an image. Write it up as reference notes for an electrician's searchable knowledge base, in your own words rather than a transcription:
- One line per clause or requirement: the clause number, then what it requires (values, limits, distances, ratings, exceptions).
- Every table as plain text: the table number and title, the column headings, then one row per line with cells separated by " | ". Keep every value exactly as printed with its units.
- Each figure: the figure number and what it shows, in a sentence.
- Leave out the page header, footer and any copyright notice. Write [unclear] for anything not legible; never guess a value.
- No introduction, no commentary.`;

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}

async function openPdf(buffer) {
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    canvasFactory: new NodeCanvasFactory(),
    standardFontDataUrl: path.join(PDFJS_DIR, 'standard_fonts') + path.sep,
    cMapUrl: path.join(PDFJS_DIR, 'cmaps') + path.sep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;
}

// The page's own text layer, lines kept where pdf.js marks them.
async function pageText(page) {
  const tc = await page.getTextContent();
  let out = '';
  for (const item of tc.items) {
    if (typeof item.str !== 'string') continue;
    out += item.str;
    out += item.hasEOL ? '\n' : (item.str.endsWith(' ') || item.str === '' ? '' : ' ');
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// When the text layer is not enough: short (a figure, a scanned page, unmapped fonts), a table (the one
// thing the text layer loses on standards), or full of glyphs that never mapped to real characters.
function needsPicture(text) {
  if (text.length < THIN_TEXT_CHARS) return true;
  if (/^\s*TABLE\s+[A-Z]?\d/m.test(text)) return true;
  const odd = (text.match(/[-�]/g) || []).length;
  return odd > text.length * 0.02;
}

async function renderJpeg(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = LONG_EDGE_PX / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvasFactory: new NodeCanvasFactory() }).promise;
  const jpeg = await canvas.encode('jpeg', 85);
  canvas.width = 0; canvas.height = 0;
  return jpeg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One Claude call. err.filtered: the copyright / safety filter said no (try differently, not again).
// err.fatal: the key or account is the problem (stop the whole job).
async function claudeRead(apiKey, prompt, jpeg) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: prompt },
    ] }],
  });
  const waits = [2000, 6000, 15000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
      throw new Error(`Could not reach Anthropic: ${err.message}`);
    }
    if (res.ok) {
      const data = await res.json();
      if (data.stop_reason === 'refusal') { const e = new Error('Declined by the model'); e.filtered = true; throw e; }
      const text = (data.content || []).map((b) => b.text || '').join('').trim();
      if (!text) throw new Error('Nothing came back for this page');
      return data.stop_reason === 'max_tokens' ? `${text}\n[The end of this page was cut off]` : text;
    }
    const errText = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 401 || res.status === 403) { const e = new Error(`Anthropic API error: ${res.status} ${errText}`); e.fatal = true; throw e; }
    // No credits: stop the whole job with a clear reason, instead of quietly keeping thin text layers page after
    // page (found for real: 65 AS/NZS 3008 pages went through that way when the balance ran out mid-run).
    if (res.status === 400 && /credit balance/i.test(errText)) { const e = new Error('The Anthropic account has no credits left (console.anthropic.com > Plans & Billing). Top up, then Read again > Only the failed pages.'); e.fatal = true; throw e; }
    if (res.status === 400 && /content filtering/i.test(errText)) { const e = new Error('Blocked by the copyright output filter'); e.filtered = true; throw e; }
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) { await sleep(waits[attempt]); continue; }
    throw new Error(`Anthropic API error: ${res.status} ${errText}`);
  }
}

// Word for word, twice (the filter is not deterministic), then as notes.
async function readPageAsPicture(apiKey, n, jpeg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { text: await claudeRead(apiKey, VERBATIM_PROMPT(n), jpeg), read_as: 'ocr' }; }
    catch (err) { if (!err.filtered) throw err; }
  }
  try { return { text: await claudeRead(apiKey, NOTES_PROMPT(n), jpeg), read_as: 'notes' }; }
  catch (err) { if (!err.filtered) throw err; throw new Error('Blocked by the copyright output filter, even as reference notes'); }
}

// Which pages this job reads. 'failed': pages that failed before, pages whose picture read failed and kept
// only the text layer (error set), and pages never stored.
async function pagesInScope(admin, job, pdfPages) {
  if (job.mode !== 'failed') return Array.from({ length: pdfPages }, (_, i) => i + 1);
  const { data: rows, error } = await admin.from('knowledge_pages').select('page_no, read_as, error').eq('entry_id', job.entry_id);
  if (error) throw new Error(error.message);
  const ok = new Set((rows || []).filter((r) => r.read_as !== 'failed' && !r.error).map((r) => r.page_no));
  const out = [];
  for (let n = 1; n <= pdfPages; n++) if (!ok.has(n)) out.push(n);
  return out;
}

async function claimJob(admin, jobId) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString();
  const { data, error } = await admin.from('knowledge_read_jobs')
    .update({ status: 'running', locked_until: lockedUntil })
    .eq('id', jobId)
    .or(`status.eq.queued,and(status.eq.running,locked_until.lt.${now.toISOString()})`)
    .select('*').maybeSingle();
  if (error) throw new Error(error.message);
  if (data && !data.started_at) await admin.from('knowledge_read_jobs').update({ started_at: now.toISOString() }).eq('id', jobId);
  return data;
}

async function callSelf(payload) {
  try {
    await fetch(`${selfBaseUrl()}/.netlify/functions/read-knowledge-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('read-knowledge: could not call itself, the sweep will pick it up:', err.message);
  }
}

async function notify(admin, job, entry, text) {
  if (!job.requested_by) return;
  await admin.rpc('create_notification', {
    p_user: job.requested_by, p_kind: 'knowledge', p_title: `${entry.title}: ${text}`,
    p_body: null, p_link: '/knowledge.html', p_actor: null, p_dedupe: `kb_read:${job.id}:${text.slice(0, 20)}`,
  }).then(() => {}, (err) => console.error('read-knowledge notify failed:', err.message));
}

async function failJob(admin, job, entry, message) {
  await admin.from('knowledge_read_jobs').update({ status: 'failed', error: String(message).slice(0, 500), finished_at: new Date().toISOString(), locked_until: null }).eq('id', job.id);
  if (entry) await notify(admin, job, entry, `read stopped: ${String(message).slice(0, 80)}`);
}

// Another read of the same entry that should go first: one that is running with a live lock, or one queued
// or running that was asked for before this one. The same pages would be read and paid for twice otherwise.
async function otherJobForEntry(admin, job) {
  const { data } = await admin.from('knowledge_read_jobs').select('id, status, locked_until, created_at')
    .eq('entry_id', job.entry_id).neq('id', job.id).in('status', ['queued', 'running']);
  const now = Date.now();
  return (data || []).find((o) =>
    (o.status === 'running' && o.locked_until && new Date(o.locked_until).getTime() > now)
    || new Date(o.created_at).getTime() < new Date(job.created_at).getTime());
}

// Works on one job until it is done or the run's time is up. Returns 'done', 'more' (called itself for the
// rest), 'cancelled', 'failed', 'duplicate' (another read of the same entry goes first) or 'busy' (someone
// else holds it).
async function runJob(admin, jobId) {
  const startedAt = Date.now();
  const job = await claimJob(admin, jobId);
  if (!job) return 'busy';

  if (!job.started_at) {
    const other = await otherJobForEntry(admin, job);
    if (other) {
      await admin.from('knowledge_read_jobs').update({ status: 'failed', error: 'A read of this entry is already queued or running. Wait for it to finish, then Read again if pages are still missing.', finished_at: new Date().toISOString(), locked_until: null }).eq('id', job.id);
      return 'duplicate';
    }
  }

  const { data: entry } = await admin.from('knowledge_entries').select('id, title, file_path, file_name, entry_type').eq('id', job.entry_id).maybeSingle();
  if (!entry) { await failJob(admin, job, null, 'The entry no longer exists'); return 'failed'; }
  if (!entry.file_path || !/\.pdf$/i.test(entry.file_name || '')) { await failJob(admin, job, entry, 'Only a PDF can be read page by page'); return 'failed'; }

  let pdf;
  try {
    const { data: file, error } = await admin.storage.from('knowledge-files').download(entry.file_path);
    if (error || !file) throw new Error(error?.message || 'Could not download the PDF');
    pdf = await openPdf(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    await failJob(admin, job, entry, `Could not open the PDF: ${err.message}`);
    return 'failed';
  }

  let apiKey;
  try { apiKey = await getIntegrationKey('anthropic'); }
  catch (err) { await failJob(admin, job, entry, `No Anthropic key: ${err.message}`); return 'failed'; }

  const pdfPages = pdf.numPages;
  const scope = await pagesInScope(admin, job, pdfPages);
  if (job.pdf_pages !== pdfPages || job.total_pages !== scope.length) {
    await admin.from('knowledge_read_jobs').update({ pdf_pages: pdfPages, total_pages: scope.length }).eq('id', job.id);
  }

  let done = job.pages_done || 0;
  let failed = job.pages_failed || 0;
  let sinceCheck = 0;
  let thisRun = 0;
  for (const n of scope) {
    if (n < job.next_page) continue;
    if (Date.now() - startedAt > RUN_BUDGET_MS || thisRun >= MAX_PAGES_PER_RUN) {
      await admin.from('knowledge_read_jobs').update({ locked_until: new Date().toISOString() }).eq('id', job.id);
      await callSelf({ job_id: job.id });
      return 'more';
    }
    if (sinceCheck++ % 10 === 0) {
      const { data: fresh } = await admin.from('knowledge_read_jobs').select('status').eq('id', job.id).maybeSingle();
      if (!fresh || fresh.status === 'cancelled') {
        if (fresh) await admin.rpc('kb_finish_read', { p_job_id: job.id });
        return 'cancelled';
      }
      await admin.from('knowledge_read_jobs').update({ locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() }).eq('id', job.id);
    }

    let text = '';
    let readAs = 'text';
    let pageError = null;
    try {
      const page = await pdf.getPage(n);
      try {
        text = await pageText(page);
        if (job.mode === 'ocr' || needsPicture(text)) {
          const jpeg = await renderJpeg(page);
          try {
            const r = await readPageAsPicture(apiKey, n, jpeg);
            text = r.text;
            readAs = r.read_as;
          } catch (err) {
            if (err.fatal) throw err;
            if (text.length >= THIN_TEXT_CHARS) {
              pageError = `Picture read failed, text layer kept: ${err.message}`.slice(0, 500);
            } else {
              text = null; readAs = 'failed'; pageError = String(err.message).slice(0, 500);
            }
          }
        }
      } finally {
        page.cleanup();
      }
    } catch (err) {
      if (err.fatal) { await failJob(admin, job, entry, err.message); return 'failed'; }
      text = null; readAs = 'failed'; pageError = `Could not render page ${n}: ${err.message}`.slice(0, 500);
    }

    if (readAs === 'failed') failed++;
    done++;
    thisRun++;
    // Postgres text cannot hold a NUL byte (a stray glyph in some PDFs' text layers): found for real on page 51
    // of AS/NZS 3012, which failed the save with "unsupported Unicode escape sequence".
    if (text) text = text.replace(/\u0000/g, '');
    const { error: upErr } = await admin.from('knowledge_pages').upsert(
      { entry_id: entry.id, page_no: n, text, read_as: readAs, error: pageError, updated_at: new Date().toISOString() },
      { onConflict: 'entry_id,page_no' });
    if (upErr) { await failJob(admin, job, entry, `Could not save page ${n}: ${upErr.message}`); return 'failed'; }
    await admin.from('knowledge_read_jobs').update({ pages_done: done, pages_failed: failed, next_page: n + 1 }).eq('id', job.id);
  }

  const { error: finErr } = await admin.rpc('kb_finish_read', { p_job_id: job.id });
  if (finErr) { await failJob(admin, job, entry, `Could not finish: ${finErr.message}`); return 'failed'; }
  await notify(admin, job, entry, failed ? `read, ${failed} of ${scope.length} pages could not be read` : `read, all ${scope.length} pages in`);
  return 'done';
}

// The next job worth running: queued, or running but its lock has lapsed (the run died).
async function nextJobId(admin) {
  const { data } = await admin.from('knowledge_read_jobs').select('id')
    .or(`status.eq.queued,and(status.eq.running,locked_until.lt.${new Date().toISOString()})`)
    .order('created_at').limit(1).maybeSingle();
  return data ? data.id : null;
}

module.exports = { runJob, nextJobId, callSelf, openPdf, pageText, needsPicture, renderJpeg, MODEL };
