const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Throwaway synchronous diagnostic - renders the real quote.html page and
// returns the outcome directly in the HTTP response, to see what actually
// happens (vs. the background version, which left no trace at all -
// success or failure - after several minutes). Delete once the real
// pipeline is confirmed working.
exports.handler = async (event) => {
  const { token } = JSON.parse(event.body || '{}');
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    const url = `https://thomsonprojects.netlify.app/quote.html?token=${token}&print=1`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
    await page.waitForSelector('body[data-print-ready="true"]', { timeout: 20000 });
    const pdfBytes = await page.pdf({ format: 'a4', printBackground: true });
    return { statusCode: 200, body: JSON.stringify({ ok: true, pdfBytes: pdfBytes.length }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, stack: err.stack }) };
  } finally {
    if (browser) await browser.close();
  }
};
