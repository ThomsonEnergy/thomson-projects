const { PDFDocument } = require('pdf-lib');
const { getAdminClient } = require('./_shared/require-admin');
const { drawCoverPage } = require('./_shared/pdf-cover-page');

// Renders the actual client-facing quote.html/invoice.html page (via
// headless Chromium - the same rich, styled page a client already sees
// through their link, stage tables/claim-remaining/payment link and all)
// into a real PDF, with a shared title/cover page (pdf-cover-page.js)
// prepended so it matches the same letterhead treatment as a signed
// onboarding document. A regular (synchronous) function, not a
// background one - Netlify's background functions get a noticeably
// smaller memory ceiling, which OOM-killed Chromium on a real,
// photo-heavy quote with no error ever surfaced (an OOM-killed container
// never gets to run a catch block). The render itself comfortably
// finishes well inside a normal function's time budget once memory isn't
// the problem, so there was never a need to background it in the first
// place - the browser just awaits this directly.

async function renderPageToPdf(url, pdfOptions) {
  // Known puppeteer-core/Chromium failure mode with pipe:true (the
  // transport this uses - see below): if the Chromium process dies
  // unexpectedly mid-render, the next CDP command's pipe write throws
  // "write EPIPE" as a genuine Node uncaughtException, not a rejected
  // promise this function's own try/catch can see - it crashes the
  // whole Lambda runtime (Runtime.ExitError) instead of just failing
  // this one request. Confirmed happening in production (duration ~11s,
  // memory ~2.9GB, stack through puppeteer-core's PipeTransport.send).
  // This temporarily installs a process-wide safety net for exactly the
  // window this risky operation runs in, converting that stray crash
  // into a normal rejection this function already knows how to report
  // (quote_pdf_error/pdf_error, a clean error response) - removed again
  // immediately after, success or failure, so it doesn't mask anything
  // unrelated to this render.
  return new Promise((resolve, reject) => {
    let settled = false;
    const onFatal = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      console.error('Uncaught error during PDF render (Chromium likely crashed):', err);
      reject(new Error(`Chromium crashed while rendering the PDF (${err?.code || err?.message || 'unknown error'}) - try again`));
    };
    function cleanupListeners() {
      process.removeListener('uncaughtException', onFatal);
      process.removeListener('unhandledRejection', onFatal);
    }
    process.once('uncaughtException', onFatal);
    process.once('unhandledRejection', onFatal);

    renderPageToPdfUnsafe(url, pdfOptions).then(
      (buf) => { if (!settled) { settled = true; cleanupListeners(); resolve(buf); } },
      (err) => { if (!settled) { settled = true; cleanupListeners(); reject(err); } }
    );
  });
}

async function renderPageToPdfUnsafe(url, pdfOptions) {
  // Required lazily, inside the function, rather than at module top level -
  // requiring puppeteer-core at module load time meant simply IMPORTING
  // this file (which Netlify's function bundler/router does for every
  // function, not just when this one is actually invoked) tripped
  // puppeteer-core's native-WebSocket check and broke every OTHER
  // function on the site with the exact same error, not just this one.
  const chromium = require('@sparticuz/chromium');
  // puppeteer-core checks for a native WebSocket global (Node 22+ only) the
  // moment it's required, and throws immediately at that point if it's
  // missing - before any launch() option (protocol/pipe/etc.) is even
  // consulted, which is why changing those had no effect. Polyfilling the
  // global with the ws package (already a puppeteer-core dependency, just
  // not exposed as a native WebSocket) before requiring puppeteer-core
  // satisfies that check on Node 18.
  globalThis.WebSocket = require('ws');
  const puppeteer = require('puppeteer-core');

  // Chromium's graphics stack/WebGL (via a bundled software renderer) is
  // on by default and costs real memory we don't need just to print HTML/
  // CSS to a PDF - this alone was plausibly enough to tip a tightly
  // memory-constrained Lambda container into an OOM kill.
  chromium.setGraphicsMode = false;
  const browser = await puppeteer.launch({
    // @sparticuz/chromium's own default args do NOT include this - and
    // Lambda's /dev/shm is tiny (often 64MB) compared to a real machine's.
    // Chromium's renderer normally uses /dev/shm for compositing buffers,
    // so it was hitting that tiny shared-memory ceiling and getting OOM-
    // killed almost immediately (~10s in, regardless of how light the
    // actual page was - confirmed against a quote with under a dozen
    // small photos still OOMing at 2048MB). This forces it onto regular
    // /tmp disk-backed memory instead, which is the documented fix for
    // exactly this failure mode in a Lambda-style container.
    args: [...chromium.args, '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    // Puppeteer's default connects to the browser over a WebSocket to
    // its remote-debugging port, which needs a native WebSocket global
    // (Node 22+ only) or a working ws-package fallback that didn't
    // trigger here - communicating over stdio pipes instead sidesteps
    // needing any WebSocket implementation at all.
    protocol: 'cdp',
    pipe: true,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200 });
    // domcontentloaded rather than networkidle0 - waiting for every image
    // to settle via Puppeteer's own network-idle heuristic held them all
    // in memory at once; the page's own data-print-ready flag (set only
    // once it has explicitly confirmed each image finished loading) is
    // the real signal to wait for anyway.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('body[data-print-ready="true"]', { timeout: 20000 });
    const pdfBytes = await page.pdf(pdfOptions || { format: 'a4', printBackground: true, margin: { top: '20px', bottom: '20px' } });
    return Buffer.from(pdfBytes);
  } finally {
    // If Chromium already crashed, this itself throws on the same dead
    // pipe - swallow that specifically (the real error from above is
    // what actually matters and is already on its way out), don't let
    // cleanup mask or replace it.
    try { await browser.close(); } catch (closeErr) { console.error('browser.close() failed (Chromium likely already exited):', closeErr.message); }
  }
}

async function buildFinalPdf(contentPdfBytes, supabaseAdmin, coverInfo) {
  const finalDoc = await PDFDocument.create();
  await drawCoverPage(finalDoc, supabaseAdmin, coverInfo);

  const contentDoc = await PDFDocument.load(contentPdfBytes);
  const copiedPages = await finalDoc.copyPages(contentDoc, contentDoc.getPageIndices());
  copiedPages.forEach((p) => finalDoc.addPage(p));

  return Buffer.from(await finalDoc.save());
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let doc_type, record_id, supabaseAdmin;
  try {
    ({ doc_type, record_id } = JSON.parse(event.body || '{}'));
    if (!doc_type || !record_id) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'doc_type and record_id are required' }) };

    supabaseAdmin = getAdminClient();
    const siteUrl = process.env.URL || 'https://thomsonprojects.netlify.app';
    if (doc_type === 'quote') await supabaseAdmin.from('projects').update({ quote_pdf_error: null }).eq('id', record_id);
    else if (doc_type === 'invoice') await supabaseAdmin.from('invoices').update({ pdf_error: null }).eq('id', record_id);

    let path;
    if (doc_type === 'quote') {
      const { data: project, error } = await supabaseAdmin
        .from('projects')
        .select('id, name, client_name, quote_number, quote_token, proposal_template')
        .eq('id', record_id)
        .single();
      if (error || !project || !project.quote_token) throw new Error(error?.message || 'Quote not found or has no link yet');

      // quote.html is now a set of full-bleed A4 pages with its own black
      // cover page (logo, title, prepared for, date), so the PDF is just
      // that page printed as-is - no separate title page is prepended any
      // more. preferCSSPageSize + zero margins let each .pg fill one sheet
      // edge to edge (the black pages bleed to the paper's edge).
      const finalPdf = await renderPageToPdf(`${siteUrl}/quote.html?token=${project.quote_token}&print=1`, {
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });

      path = `client-documents/quotes/${project.id}.pdf`;
      const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(path, finalPdf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      await supabaseAdmin.from('projects').update({ quote_pdf_path: path, quote_pdf_generated_at: new Date().toISOString() }).eq('id', project.id);
    } else if (doc_type === 'invoice') {
      const { data: invoice, error } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, invoice_token, project_id, projects(name, client_name)')
        .eq('id', record_id)
        .single();
      if (error || !invoice || !invoice.invoice_token) throw new Error(error?.message || 'Invoice not found or has no link yet');

      const contentPdfBytes = await renderPageToPdf(`${siteUrl}/invoice.html?token=${invoice.invoice_token}&print=1`);
      const finalPdf = await buildFinalPdf(contentPdfBytes, supabaseAdmin, {
        docTitle: `Tax Invoice ${invoice.invoice_number}`,
        preparedFor: invoice.projects?.client_name || null,
        subtitle: invoice.projects?.name || null,
        dateLabel: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
        showCoverPhoto: true,
      });

      path = `client-documents/invoices/${invoice.id}.pdf`;
      const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(path, finalPdf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      await supabaseAdmin.from('invoices').update({ pdf_path: path, pdf_generated_at: new Date().toISOString() }).eq('id', invoice.id);
    } else {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: `Unknown doc_type "${doc_type}"` }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, path }) };
  } catch (err) {
    console.error('generate-client-document-pdf failed:', err);
    if (supabaseAdmin && record_id) {
      if (doc_type === 'quote') await supabaseAdmin.from('projects').update({ quote_pdf_error: err.message }).eq('id', record_id).then(() => {}, () => {});
      else if (doc_type === 'invoice') await supabaseAdmin.from('invoices').update({ pdf_error: err.message }).eq('id', record_id).then(() => {}, () => {});
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
