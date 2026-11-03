// Dead code check, run by npm run check (and on its own: node scripts/deadcode.js).
// Finds code nothing uses:
//   1. Netlify functions no page, script, function, schedule or redirect names.
//   2. public/js files no page, script or service worker loads.
//   3. _shared exports nothing outside their own file mentions.
//   4. ?v= numbers out of step: the same /js or /css file loaded with different
//      version numbers on different pages (someone bumped one page and not the rest).
// A name is "used" when it appears as a whole word anywhere outside its own file, so
// dynamic calls (`/.netlify/functions/${name}`) still count as long as the name is
// written down somewhere. That is deliberately generous: a false "dead" is worse
// than a miss, the weekly cleanup catches the rest.
//
// scripts/deadcode-baseline.json lists what was already dead when the check went in,
// and under "keep" the findings that are wrong by design (a webhook an outside service
// calls) with the reason. Only NEW findings fail. Findings that leave the baseline are reported so the file
// can be trimmed (node scripts/deadcode.js --write-baseline rewrites it from today).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const baselineFile = path.join(root, 'scripts', 'deadcode-baseline.json');

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every text file a name could be written in.
const sources = [
  ...walk(path.join(root, 'public'), ['.html', '.js', '.css', '.json', '.webmanifest']),
  ...walk(path.join(root, 'netlify'), ['.js', '.json']),
  ...walk(path.join(root, 'scripts'), ['.js', '.sh']),
  ...walk(path.join(root, 'agents'), ['.js', '.json', '.md']),
  ...walk(path.join(root, 'tego-app', 'native-shell'), ['.html', '.js']),
  ...walk(path.join(root, 'supabase'), ['.sql']),
  path.join(root, 'netlify.toml'),
].filter((f) => fs.existsSync(f) && !f.includes(`${path.sep}vendor${path.sep}`) && rel(f) !== 'scripts/deadcode-baseline.json');
const text = new Map(sources.map((f) => [f, fs.readFileSync(f, 'utf8')]));

function mentionedOutside(name, ownFile) {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}([^A-Za-z0-9_-]|$)`);
  for (const [f, body] of text) {
    if (f === ownFile) continue;
    if (re.test(body)) return true;
  }
  return false;
}

const findings = [];

// 1. Netlify functions.
const fnDir = path.join(root, 'netlify', 'functions');
for (const file of walk(fnDir, ['.js'])) {
  if (file.includes(`${path.sep}_shared${path.sep}`)) continue;
  const name = path.basename(file, '.js');
  if (!mentionedOutside(name, file)) findings.push(`function ${rel(file)}: nothing calls, schedules or redirects to it`);
}

// 2. public/js files.
for (const file of walk(path.join(root, 'public', 'js'), ['.js'])) {
  if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
  const name = `/js/${rel(file).replace(/^public\/js\//, '')}`;
  if (!mentionedOutside(name, file)) findings.push(`script ${rel(file)}: no page loads it`);
}

// 3. _shared exports. Reads `module.exports = { a, b: c, ... }` and `exports.x =`.
for (const file of walk(path.join(fnDir, '_shared'), ['.js'])) {
  const body = text.get(file) || fs.readFileSync(file, 'utf8');
  const names = new Set();
  const block = body.match(/module\.exports\s*=\s*\{([\s\S]*?)\};?/);
  if (block) {
    for (const part of block[1].split(',')) {
      const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
      if (m) names.add(m[1]);
    }
  }
  for (const m of body.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const name of names) {
    if (!mentionedOutside(name, file)) findings.push(`export ${name} in ${rel(file)}: nothing outside the file uses it`);
  }
}

// 4. ?v= out of step.
const versions = new Map(); // file -> Map(version -> [pages])
for (const [f, body] of text) {
  if (!f.endsWith('.html')) continue;
  for (const m of body.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"?]+)\?v=(\d+)"/g)) {
    const [, asset, v] = m;
    if (!versions.has(asset)) versions.set(asset, new Map());
    const byV = versions.get(asset);
    if (!byV.has(v)) byV.set(v, []);
    byV.get(v).push(rel(f));
  }
}
for (const [asset, byV] of versions) {
  if (byV.size < 2) continue;
  const detail = [...byV].map(([v, pages]) => `v=${v} on ${pages.length} page${pages.length === 1 ? '' : 's'} (${pages.slice(0, 3).join(', ')}${pages.length > 3 ? ', ...' : ''})`).join('; ');
  findings.push(`version ${asset}: loaded with different ?v= numbers: ${detail}`);
}

findings.sort();

if (process.argv.includes('--write-baseline')) {
  const old = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
  const keep = old.keep || {};
  fs.writeFileSync(baselineFile, JSON.stringify({ written: new Date().toISOString().slice(0, 10), keep, findings: findings.filter((f) => !keep[f]) }, null, 2) + '\n');
  console.log(`deadcode: baseline written with ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  process.exit(0);
}

const saved = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
const baseline = saved.findings || [];
const keep = saved.keep || {};
const baselineSet = new Set([...baseline, ...Object.keys(keep)]);
const current = new Set(findings);
const fresh = findings.filter((f) => !baselineSet.has(f));
const cleared = baseline.filter((f) => !current.has(f));

for (const f of cleared) console.log(`deadcode cleared (remove from baseline): ${f}`);
for (const f of fresh) console.error(`FAIL deadcode: ${f}`);
console.log(`deadcode: ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${baseline.length} in baseline, ${fresh.length} new, ${cleared.length} cleared`);

module.exports = { findings, fresh, cleared };
if (require.main === module) process.exit(fresh.length ? 1 : 0);
