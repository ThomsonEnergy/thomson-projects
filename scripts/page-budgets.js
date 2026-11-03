// Page weight check, run by npm run check (and on its own: node scripts/page-budgets.js).
// A page's weight is its HTML plus every local /js and /css file it loads (vendor
// included, since the phone downloads it too). scripts/page-budgets.json holds the
// budget per page in bytes; a page over its budget fails. Pages not listed get the
// default budget in that file.
//
// The budgets were set from the sizes on the day the check went in (rounded up to the
// next 5 KB). The rule from docs/SOFTWARE_FACTORY.md: a budget goes up only when the
// PR says why, and the pages under "onlyDown" (project.html, settings.html) only ever
// go down. node scripts/page-budgets.js --write-budgets rewrites the file from today's
// sizes, never raising an onlyDown page (use it once a cleanup has made pages smaller,
// so the new size becomes the new ceiling).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const budgetFile = path.join(root, 'scripts', 'page-budgets.json');
const KB = 1024;
const roundUp = (n) => Math.ceil(n / (5 * KB)) * 5 * KB;

function weigh(page) {
  const html = fs.readFileSync(page, 'utf8');
  const assets = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"?#]+)/g)) assets.add(m[1]);
  let bytes = Buffer.byteLength(html);
  const parts = [];
  for (const a of assets) {
    const f = path.join(pub, a);
    if (!fs.existsSync(f)) continue;
    const size = fs.statSync(f).size;
    bytes += size;
    parts.push({ asset: a, size });
  }
  return { bytes, parts: parts.sort((x, y) => y.size - x.size) };
}

const pages = fs.readdirSync(pub).filter((f) => f.endsWith('.html')).sort();
const weights = Object.fromEntries(pages.map((p) => [p, weigh(path.join(pub, p))]));

if (process.argv.includes('--write-budgets')) {
  const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : {};
  const onlyDown = existing.onlyDown || [];
  const out = { written: new Date().toISOString().slice(0, 10), default: existing.default || 800 * KB, onlyDown, pages: {} };
  for (const p of pages) {
    const fresh = roundUp(weights[p].bytes);
    const old = (existing.pages || {})[p];
    out.pages[p] = onlyDown.includes(p) && old ? Math.min(old, fresh) : fresh;
  }
  fs.writeFileSync(budgetFile, JSON.stringify(out, null, 2) + '\n');
  console.log(`page-budgets: budgets written for ${pages.length} pages`);
  process.exit(0);
}

const budgets = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : { default: 800 * KB, pages: {} };
const over = [];
for (const p of pages) {
  const budget = budgets.pages[p] || budgets.default;
  const { bytes, parts } = weights[p];
  if (bytes > budget) {
    const biggest = parts.slice(0, 2).map((x) => `${x.asset} ${Math.round(x.size / KB)} KB`).join(', ');
    over.push(`${p}: ${Math.round(bytes / KB)} KB, budget ${Math.round(budget / KB)} KB${biggest ? ` (biggest: ${biggest})` : ''}`);
  }
}

if (process.argv.includes('--list')) {
  for (const p of [...pages].sort((a, b) => weights[b].bytes - weights[a].bytes)) {
    console.log(`${String(Math.round(weights[p].bytes / KB)).padStart(6)} KB  ${p}  (budget ${Math.round((budgets.pages[p] || budgets.default) / KB)} KB)`);
  }
}

for (const o of over) console.error(`FAIL page-budgets: ${o}`);
console.log(`page-budgets: ${pages.length} pages, ${over.length} over budget`);

module.exports = { weights, over };
if (require.main === module) process.exit(over.length ? 1 : 0);
