// Smoke run for the Prove step (docs/SOFTWARE_FACTORY.md). Opens pages in a real browser
// as a staging test login, records load time, page errors, console errors and failed
// calls, takes phone and desktop screenshots, and optionally clicks through a steps file
// (the plan's "Done means"). Playwright is pre-installed in cloud sessions.
//
//   node scripts/smoke.js --base https://staging--thomsonprojects.netlify.app --login sales \
//     --pages home.html,inbox.html --label before --out smoke/before [--steps scripts/steps/my-feature.js]
//   node scripts/smoke.js --compare smoke/before smoke/after > smoke/table.md
//
// --login: admin | finance | sales | staff (the staging test accounts in docs/STAGING.md,
//   password from SMOKE_PASSWORD or the documented staging one). --login none skips login.
// --steps: a file exporting async (page, { base, shot }) => {}; it runs on the desktop
//   view of the first page, and shot('name') saves a screenshot at that point.
// Exit code 1 when any page threw an error or a same-origin call failed; console
// errors and third-party failures are listed but do not fail (--strict makes them fail).
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const STAGING_PASSWORD = 'StagingOnly-TEops-2026'; // test accounts only (docs/STAGING.md)

if (flag('compare')) {
  const [beforeDir, afterDir] = args.slice(args.indexOf('--compare') + 1, args.indexOf('--compare') + 3);
  process.stdout.write(compare(beforeDir, afterDir));
  process.exit(0);
}

(async () => {
  const base = (opt('base', '') || '').replace(/\/$/, '');
  if (!base) { console.error('smoke: --base is required'); process.exit(2); }
  const login = opt('login', 'sales');
  const pages = (opt('pages', 'home.html') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const label = opt('label', 'run');
  const out = path.resolve(opt('out', `smoke/${label}`));
  const stepsFile = opt('steps', '');
  fs.mkdirSync(out, { recursive: true });

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const results = [];
  let failed = false;

  for (const [view, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
    const page = await context.newPage();
    if (login !== 'none') await signIn(page, base, login);

    for (const [i, target] of pages.entries()) {
      const r = { page: target, view, ms: 0, pageErrors: [], consoleErrors: [], failedCalls: [], screenshot: '' };
      page.removeAllListeners('pageerror'); page.removeAllListeners('console'); page.removeAllListeners('response'); page.removeAllListeners('requestfailed');
      page.on('pageerror', (e) => r.pageErrors.push(String(e.message || e).slice(0, 300)));
      page.on('console', (m) => { if (m.type() === 'error') r.consoleErrors.push(m.text().slice(0, 300)); });
      page.on('response', (res) => { if (res.status() >= 400) r.failedCalls.push(`${res.status()} ${short(res.url(), base)}`); });
      page.on('requestfailed', (req) => r.failedCalls.push(`failed ${short(req.url(), base)} (${req.failure()?.errorText || ''})`));

      const t0 = Date.now();
      try {
        await page.goto(`${base}/${target}`, { waitUntil: 'load', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      } catch (e) { r.pageErrors.push(`navigation: ${e.message.split('\n')[0]}`); }
      r.ms = Date.now() - t0;
      r.screenshot = `${safe(target)}-${view}.png`;
      await page.screenshot({ path: path.join(out, r.screenshot), fullPage: true }).catch(() => {});

      if (stepsFile && view === 'desktop' && i === 0) {
        const steps = require(path.resolve(stepsFile));
        let n = 0;
        const shot = async (name) => { n++; const f = `${safe(target)}-step${n}-${safe(name)}.png`; await page.screenshot({ path: path.join(out, f), fullPage: true }); r.stepShots = [...(r.stepShots || []), f]; };
        try { await steps(page, { base, shot }); r.steps = 'passed'; }
        catch (e) { r.steps = `failed: ${e.message.split('\n')[0]}`; r.pageErrors.push(`steps: ${e.message.split('\n')[0]}`); }
      }

      const ownFailures = r.failedCalls.filter((c) => /^(5\d\d|failed) \//.test(c));
      if (r.pageErrors.length || ownFailures.length || (flag('strict') && (r.consoleErrors.length || r.failedCalls.length))) failed = true;
      results.push(r);
      console.log(`${view.padEnd(8)} ${target.padEnd(28)} ${String(r.ms).padStart(6)} ms  errors ${r.pageErrors.length}  console ${r.consoleErrors.length}  failed calls ${r.failedCalls.length}${r.steps ? `  steps ${r.steps}` : ''}`);
    }
    await context.close();
  }
  await browser.close();

  const summary = { label, base, login, when: new Date().toISOString(), results };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'summary.md'), table(summary));
  console.log(`smoke: ${results.length} page views, ${failed ? 'FAILED' : 'passed'}, written to ${path.relative(process.cwd(), out)}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke:', e.message); process.exit(2); });

async function signIn(page, base, role) {
  const email = role.includes('@') ? role : `${role}@staging.test`;
  const password = process.env.SMOKE_PASSWORD || STAGING_PASSWORD;
  await page.goto(`${base}/login.html`, { waitUntil: 'load', timeout: 45000 });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/login.html'), { timeout: 30000 }),
    page.click('#login-form button[type="submit"]'),
  ]).catch(() => { throw new Error(`login as ${email} did not leave login.html (wrong password, or the account is not on this site)`); });
}

function short(url, base) { return url.startsWith(base) ? url.slice(base.length) : url.replace(/^https?:\/\//, ''); }
function safe(s) { return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(); }

function table(summary) {
  const lines = [`### Smoke run: ${summary.label} (${summary.base}, login ${summary.login})`, '', '| Page | View | Load | Page errors | Console errors | Failed calls | Steps |', '|---|---|---|---|---|---|---|'];
  for (const r of summary.results) lines.push(`| ${r.page} | ${r.view} | ${r.ms} ms | ${r.pageErrors.length} | ${r.consoleErrors.length} | ${r.failedCalls.length} | ${r.steps || ''} |`);
  const detail = summary.results.filter((r) => r.pageErrors.length || r.failedCalls.length);
  if (detail.length) {
    lines.push('', 'Detail:');
    for (const r of detail) for (const d of [...r.pageErrors, ...r.failedCalls]) lines.push(`- ${r.page} (${r.view}): ${d}`);
  }
  return lines.join('\n') + '\n';
}

// Before and after side by side, for the PR body. Screenshot cells hold the file names;
// the ship skill swaps them for links once the images are on the pr-assets branch.
function compare(beforeDir, afterDir) {
  const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'results.json'), 'utf8'));
  const b = read(beforeDir), a = read(afterDir);
  const key = (r) => `${r.page}|${r.view}`;
  const bm = new Map(b.results.map((r) => [key(r), r]));
  const lines = ['| Page | View | Load before | Load after | Errors before | Errors after | Before | After |', '|---|---|---|---|---|---|---|---|'];
  for (const r of a.results) {
    const o = bm.get(key(r));
    const errs = (x) => (x ? x.pageErrors.length + x.failedCalls.filter((c) => /^(5\d\d|failed) \//.test(c)).length : '');
    lines.push(`| ${r.page} | ${r.view} | ${o ? `${o.ms} ms` : ''} | ${r.ms} ms | ${errs(o)} | ${errs(r)} | ${o ? `${path.basename(beforeDir)}/${o.screenshot}` : ''} | ${path.basename(afterDir)}/${r.screenshot} |`);
  }
  return lines.join('\n') + '\n';
}
