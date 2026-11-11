// Proof step for the client proposal (public/quote.html): renders a made-up Solar and Battery quote
// in a real browser with no network (the two database calls are answered from a fixture), as the
// A4 sheets the PDF is cut into and as a phone, and fails when any page's content is wider than
// its sheet or runs past the bottom of it. Run it after any change to quote.html or solar-roi.js:
//
//   node scripts/proposal-fits.js                      (exit 1 and a list when a page does not fit)
//   node scripts/proposal-fits.js --out smoke/proposal (also saves a picture of every page)
//   node scripts/proposal-fits.js --fixture path.json  (another quote, the shape get_quote_by_token returns)
//   node scripts/proposal-fits.js --root ../other/public (another copy of the site, for a before picture)
//
// Playwright is pre-installed in cloud sessions (as for scripts/smoke.js). Nothing is written anywhere
// but --out. The fixture holds no real client: scripts/fixtures/proposal-solar-battery.json.
const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const root = path.resolve(opt('root', path.join(__dirname, '..', 'public')));
const fixture = JSON.parse(fs.readFileSync(path.resolve(opt('fixture', path.join(__dirname, 'fixtures', 'proposal-solar-battery.json'))), 'utf8'));
const out = opt('out', '') ? path.resolve(opt('out', '')) : null;
const settings = { company_name: 'Thomson Energy', logo_url: null, abn: '00 000 000 000', phone: '0400 000 000', address: '1 Fixture Way, Testville NSW 2000', licenses: 'Fixture licence' };
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const VIEWS = [
  { name: 'sheets', viewport: { width: 1000, height: 1200 }, query: '&print=1' }, // what the PDF is made from
  { name: 'phone', viewport: { width: 390, height: 844 }, query: '' },
];

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  if (out) fs.mkdirSync(out, { recursive: true });

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const problems = [];
  for (const view of VIEWS) {
    const context = await browser.newContext({ viewport: view.viewport, deviceScaleFactor: 1, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${view.name}: page error: ${String(e.message || e).slice(0, 200)}`));
    // ?print=1 opens the browser's print box when the page is ready: not wanted here
    await page.addInitScript(() => { window.print = () => {}; });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost') return route.continue();
      if (url.pathname.includes('/rpc/get_quote_by_token')) return route.fulfill({ json: fixture });
      if (url.pathname.includes('/rpc/get_public_company_settings')) return route.fulfill({ json: settings });
      return route.fulfill({ json: [] }); // fonts, pictures and anything else off the machine
    });
    await page.goto(`${base}/quote.html?token=fixture${view.query}`);
    await page.waitForFunction(() => document.body.dataset.printReady === 'true', null, { timeout: 20000 });
    // every page: how far its content sticks out past its right edge and its bottom edge
    const pages = await page.evaluate(() => [...document.querySelectorAll('.pg')].map((pg, i) => {
      const box = pg.getBoundingClientRect();
      let right = 0; let bottom = 0;
      pg.querySelectorAll('.pg-body *').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && b.height) { right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom); } });
      const title = ((pg.querySelector('h1, .sec-title, th') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return { i: i + 1, title, overRight: Math.round(right - box.right), overBottom: Math.round(bottom - box.bottom), sideways: pg.scrollWidth - pg.clientWidth };
    }));
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (view.name === 'phone' && sideways > 1) problems.push(`phone: the page scrolls sideways by ${sideways}px`);
    pages.forEach((p) => {
      if (p.overRight > 1 || p.sideways > 1) problems.push(`${view.name}: page ${p.i} "${p.title}" is ${Math.max(p.overRight, p.sideways)}px wider than its sheet`);
      if (p.overBottom > 1) problems.push(`${view.name}: page ${p.i} "${p.title}" runs ${p.overBottom}px past the bottom of its sheet`);
    });
    console.log(`${view.name}: ${pages.length} pages`);
    if (out) {
      const els = await page.$$('.pg');
      for (const [i, el] of els.entries()) await el.screenshot({ path: path.join(out, `${view.name}-${String(i + 1).padStart(2, '0')}.png`) });
    }
    await context.close();
  }
  await browser.close();
  server.close();
  if (problems.length) { console.error('proposal-fits: FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('proposal-fits: every page fits its sheet and the phone');
})().catch((err) => { console.error('proposal-fits:', err.message || err); process.exit(2); });
