// Done means for item 74 PR 1 (the client portal), as clicks. Runs on the desktop view of
// portal.html with --login none against the staging seed: Acme Builders (TEST),
// accounts@acme.example.test, J9002 made a direct job with a clocked shift, a booking the client
// was told about, one shared and one hidden photo and PO9901. The session row for the token
// below is in the seed (its hash only); the password login is tried first, then the seeded session.
const TOKEN = 'smoke-portal-token-acme-0001';
const J9002 = '00000000-0000-4000-c000-000000000002';
const JANES_QUOTE = '00000000-0000-4000-c000-000000000001'; // another client's

module.exports = async (page, { base, shot }) => {
  const text = async (sel) => (await page.locator(sel).first().textContent()) || '';
  // 0. logged out: email and password
  await page.waitForSelector('#pl-email');
  await shot('login');
  await page.fill('#pl-email', 'accounts@acme.example.test');
  await page.fill('#pl-password', 'StagingOnly-Portal-2026');
  await page.click('#pl-go');
  await page.waitForSelector('.pl-row');
  // a wrong password is refused with the same words whoever you are
  await page.evaluate(() => localStorage.removeItem('te_portal_token'));
  await page.goto(`${base}/portal.html`);
  await page.fill('#pl-email', 'nobody@example.test');
  await page.fill('#pl-password', 'wrong-password-1');
  await page.click('#pl-go');
  await page.waitForSelector('#pl-msg .error-box');
  if (!/do not match/.test(await text('#pl-msg'))) throw new Error('a wrong password should be refused');
  // the rest on the seeded session
  await page.evaluate((t) => localStorage.setItem('te_portal_token', t), TOKEN);
  await page.goto(`${base}/portal.html`);
  await page.waitForSelector('.pl-row');
  // 1. the lists: J9002 as a job with a plain status; the client's name at the top
  const body = await text('#pl-main');
  if (!/Acme Builders/.test(body)) throw new Error('the client name should show');
  const row = page.locator('.pl-row:has-text("J9002")');
  if (!(await row.count())) throw new Error('J9002 should be in the jobs list');
  if (!/Booked for|On site now/.test(await row.textContent())) throw new Error('J9002 should read Booked for ... or On site now');
  await shot('lists');
  // 2. another client's job id: not on your account
  await page.goto(`${base}/portal.html?job=${JANES_QUOTE}`);
  await page.waitForSelector('.error-box');
  if (!/not on your account/i.test(await text('.error-box'))) throw new Error("another client's job should be refused");
  // 3. the job page: booking with first name, one shared photo only, work so far
  await page.goto(`${base}/portal.html?job=${J9002}`);
  await page.waitForSelector('#pl-work .pl-big');
  const job = await text('#pl-main');
  if (!/Bookings/.test(job)) throw new Error('bookings card missing');
  if ((await page.locator('.pl-grid img').count()) !== 1) throw new Error('exactly one shared photo should show');
  if (/Internal \(portal smoke\)/.test(job)) throw new Error('the hidden photo leaked');
  if (!/PO9901/.test(job) || !/Ordered, waiting for pickup/.test(job)) throw new Error('PO9901 should show as ordered');
  if (!/not yet invoiced/i.test(job)) throw new Error('the not yet invoiced line is missing');
  if (!/SI9101/.test(job) || /SI9102/.test(job)) throw new Error('sent invoices only: SI9101 in, SI9102 (never sent) out');
  await shot('job');
  await page.evaluate(() => localStorage.removeItem('te_portal_token'));
};
