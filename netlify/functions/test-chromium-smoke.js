const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Throwaway smoke test - confirms headless Chromium actually launches in
// this Netlify Functions environment before building real PDF generation
// on top of it. Delete once the quote/invoice PDF pipeline is live and
// proven.
exports.handler = async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setContent('<h1>Hello from headless Chromium</h1>');
    const pdfBytes = await page.pdf({ format: 'a4' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, pdfBytes: pdfBytes.length }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, stack: err.stack }) };
  } finally {
    if (browser) await browser.close();
  }
};
