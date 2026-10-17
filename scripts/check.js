// Syntax check for everything that ships: every JS file, every inline
// <script> block in the HTML pages, and every SQL migration.
// Run with: npm run check
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failures = 0;
let checked = 0;

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function fail(file, err) {
  failures++;
  console.error(`FAIL ${path.relative(root, file)}: ${err.message.split('\n')[0]}`);
}

// Compiles without running. Wrapped in an async function so top-level
// return/await are allowed; ES module import/export lines are blanked first
// (same line count, so error positions stay right).
function checkJs(code, file, isModule) {
  checked++;
  if (isModule) code = code.replace(/^\s*(import\s[^\n]*|export\s+\{[^\n]*)$/gm, '').replace(/^(\s*)export\s+(default\s+)?/gm, '$1');
  try { new vm.Script(`(async function(){\n${code}\n})`, { filename: file }); }
  catch (err) { fail(file, err); }
}

// 1. JS files (functions are CommonJS, browser files are classic scripts).
for (const file of [...walk(path.join(root, 'netlify'), '.js'), ...walk(path.join(root, 'public', 'js'), '.js'), ...walk(path.join(root, 'scripts'), '.js')]) {
  if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
  const code = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*(import|export)\s/m.test(code);
  checkJs(code, file, isModule);
}

// 2. Inline <script> blocks in HTML (skips src= scripts and JSON blocks).
for (const file of walk(path.join(root, 'public'), '.html')) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    n++;
    if (/\bsrc\s*=/.test(attrs) || !m[2].trim()) continue;
    if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template)/i.test(attrs)) continue;
    const isModule = /type\s*=\s*["']?module/i.test(attrs);
    checkJs(m[2], `${file}#script${n}`, isModule);
  }
}

(async () => {
// 3. SQL migrations (real Postgres parser, installed by scripts/cloud-setup.sh).
let pg;
try { pg = require('libpg-query'); if (pg.loadModule) await pg.loadModule(); } catch (e) { pg = null; }
const sqlFiles = walk(path.join(root, 'supabase', 'migrations'), '.sql');
if (!pg) {
  console.warn('SKIP SQL: run scripts/cloud-setup.sh first (installs libpg-query)');
} else {
  for (const file of sqlFiles) {
    checked++;
    try { pg.parseSync(fs.readFileSync(file, 'utf8')); } catch (err) { fail(file, err); }
  }
}

// 4. Every create policy needs a drop policy if exists right before it.
for (const file of sqlFiles) {
  const sql = fs.readFileSync(file, 'utf8').toLowerCase();
  const creates = sql.match(/create\s+policy\s+("[^"]+"|\S+)\s+on\s+(\S+)/g) || [];
  for (const c of creates) {
    const [, name, table] = c.match(/create\s+policy\s+("[^"]+"|\S+)\s+on\s+(\S+)/);
    const drop = new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${name.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}\\s+on\\s+${table.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}`);
    if (!drop.test(sql)) fail(file, new Error(`create policy ${name} on ${table} has no matching drop policy if exists`));
  }
}

console.log(`${checked} checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
})();
