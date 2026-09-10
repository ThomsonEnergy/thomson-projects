const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');
const { getAdminClient } = require('./_shared/require-admin');
const { drawCoverPage } = require('./_shared/pdf-cover-page');

// Renders the actual client-facing quote.html/invoice.html page (via
// headless Chromium - the same rich, styled page a client already sees
// through their link, stage tables/claim-remaining/payment link and all)
// into a real PDF, with a shared title/cover page (pdf-cover-page.js)
// prepended so it matches the same letterhead treatment as a signed
// onboarding document. Runs as a background function (Chromium's cold
// start plus a full page render can occasionally run past a normal
// function's ~10s budget) - triggered on demand from project.html rather
// than automatically on every edit, since it's a real render, not free.

async function renderPageToPdf(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
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
  let doc_type, record_id, supabaseAdmin;
  try {
    ({ doc_type, record_id } = JSON.parse(event.body || '{}'));
    if (!doc_type || !record_id) return { statusCode: 202, body: '' };

    supabaseAdmin = getAdminClient();
    const siteUrl = process.env.URL || 'https://thomsonprojects.netlify.app';
    // Clear any stale error from a previous attempt before this one - the
    // browser polls for either a fresh pdf_generated_at or a pdf_error, so
    // an old error left in place would look like this attempt failed too.
    if (doc_type === 'quote') await supabaseAdmin.from('projects').update({ quote_pdf_error: null }).eq('id', record_id);
    else if (doc_type === 'invoice') await supabaseAdmin.from('invoices').update({ pdf_error: null }).eq('id', record_id);

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

      const path = `client-documents/quotes/${project.id}.pdf`;
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

      const path = `client-documents/invoices/${invoice.id}.pdf`;
      const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(path, finalPdf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      await supabaseAdmin.from('invoices').update({ pdf_path: path, pdf_generated_at: new Date().toISOString() }).eq('id', invoice.id);
    }
  } catch (err) {
    console.error('generate-client-document-pdf-background failed:', err);
    if (supabaseAdmin && record_id) {
      if (doc_type === 'quote') await supabaseAdmin.from('projects').update({ quote_pdf_error: err.message }).eq('id', record_id).then(() => {}, () => {});
      else if (doc_type === 'invoice') await supabaseAdmin.from('invoices').update({ pdf_error: err.message }).eq('id', record_id).then(() => {}, () => {});
    }
  }
  return { statusCode: 202, body: '' };
};
