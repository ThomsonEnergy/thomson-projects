const chromium = require('@sparticuz/chromium');
// puppeteer-core depends on ws for its WebSocket transport, but only
// requires it conditionally at runtime (falling back from a native
// WebSocket that doesn't exist before Node 22) - esbuild's static bundler
// doesn't follow that conditional require, so ws never made it into the
// deployed function bundle without an explicit, unconditional require
// here forcing it in.
require('ws');
const puppeteer = require('puppeteer-core');
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

async function renderPageToPdf(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    // Puppeteer's newer default (WebDriver BiDi) requires a native
    // WebSocket global, only available from Node 22+ - forcing the
    // classic Chrome DevTools Protocol keeps this working on Node 18
    // (which this whole stack is pinned to for Chromium compatibility -
    // see .nvmrc) via the ws package instead.
    protocol: 'cdp',
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
    const pdfBytes = await page.pdf({ format: 'a4', printBackground: true, margin: { top: '20px', bottom: '20px' } });
    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
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

      const contentPdfBytes = await renderPageToPdf(`${siteUrl}/quote.html?token=${project.quote_token}&print=1`);
      const docLabel = project.proposal_template === 'quick_estimate' ? 'Estimate' : 'Proposal';
      const finalPdf = await buildFinalPdf(contentPdfBytes, supabaseAdmin, {
        docTitle: `${docLabel}${project.quote_number ? ` Q${project.quote_number}` : ''}`,
        preparedFor: project.client_name,
        subtitle: project.name,
        dateLabel: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
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
