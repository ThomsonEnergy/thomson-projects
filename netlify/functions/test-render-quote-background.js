const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { getAdminClient } = require('./_shared/require-admin');

// Throwaway diagnostic - the exact same render that succeeded as a
// synchronous function, run as a background function instead, writing
// its outcome to quote_pdf_error on the test project (reusing an
// existing column rather than adding a scratch one) since a background
// function's own response body is never seen by anyone. Isolates whether
// background functions specifically get a lower memory ceiling than
// synchronous ones. Delete once diagnosed.
exports.handler = async (event) => {
  const supabaseAdmin = getAdminClient();
  const { token, record_id } = JSON.parse(event.body || '{}');
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200 });
    const url = `https://thomsonprojects.netlify.app/quote.html?token=${token}&print=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('body[data-print-ready="true"]', { timeout: 20000 });
    const pdfBytes = await page.pdf({ format: 'a4', printBackground: true });
    await supabaseAdmin.from('projects').update({ quote_pdf_error: `DIAG_OK bytes=${pdfBytes.length}` }).eq('id', record_id);
  } catch (err) {
    await supabaseAdmin.from('projects').update({ quote_pdf_error: `DIAG_FAIL ${err.message}` }).eq('id', record_id).then(() => {}, () => {});
  } finally {
    if (browser) await browser.close();
  }
  return { statusCode: 202, body: '' };
};
