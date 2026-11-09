// Done means for item 61 (the Invoices page as the accounts desk), as clicks. Runs on the desktop
// view of invoices.html as admin@staging.test against the seeded TEST invoices on J9002:
// SI9101 (emailed, overdue), SI9102 (not sent), SI9103 (deposit, in Xero, paid).
module.exports = async (page, { base, shot }) => {
  const text = async (sel) => (await page.locator(sel).first().textContent()) || '';
  await page.waitForSelector('#invoice-filters .settings-tab');
  await shot('list-needs-sending');

  // 1. Needs sending shows the unsent invoice as Not sent
  if (!/Not sent/.test(await text('tr.invoice-row:has-text("SI9102") .badge'))) throw new Error('SI9102 should read Not sent');

  // 2. Overdue shows the emailed invoice with its last action from the history
  await page.click('#invoice-filters .settings-tab[data-filter="overdue"]');
  const overdueRow = page.locator('tr.invoice-row:has-text("SI9101")');
  if (!/Overdue \d+ day/.test(await overdueRow.locator('.badge').textContent())) throw new Error('SI9101 should read Overdue N days');
  if (!/Emailed to client by Test Sales/.test(await overdueRow.textContent())) throw new Error('SI9101 last action should be the email by Test Sales');
  await shot('list-overdue');

  // Open the panel on the overdue invoice: history, Send reminder offered
  await overdueRow.click();
  await page.waitForSelector('#ip-card h2:has-text("SI9101")');
  await page.waitForSelector('#ip-card #ip-remind');
  if (!/Emailed to client/.test(await text('#ip-card ol'))) throw new Error('SI9101 history should show Emailed to client');
  await shot('panel-overdue');
  await page.click('#ip-card #ip-close');

  // 3. Edit the unsent invoice from the panel: the amount changes and the history says Edited with old and new totals
  await page.click('#invoice-filters .settings-tab[data-filter="needs_sending"]');
  await page.click('tr.invoice-row:has-text("SI9102")');
  await page.waitForSelector('#ip-card h2:has-text("SI9102")');
  await page.click('#ip-card #ip-edit');
  await page.waitForSelector('.ei-labour');
  await page.fill('.ei-labour[data-i="0"]', '1100');
  await shot('edit-panel');
  await page.click('#ei-save-btn');
  await page.waitForSelector('#ip-card ol li:has-text("Edited")', { timeout: 20000 });
  if (!/Total ex GST \$1,500\.00 to \$1,600\.00/.test(await text('#ip-card ol'))) throw new Error('history should say Total ex GST $1,500.00 to $1,600.00');
  await shot('panel-after-edit');

  // Sent another way records a send, the status moves off Not sent
  page.once('dialog', (d) => d.accept('posted 8 Nov (TEST)'));
  await page.click('#ip-card #ip-sent-elsewhere');
  await page.waitForSelector('#ip-card ol li:has-text("Sent another way")', { timeout: 20000 });
  if (!/Sent, awaiting payment/.test(await text('#ip-card .badge'))) throw new Error('SI9102 should now read Sent, awaiting payment');
  await page.click('#ip-card #ip-close');
  // the list reloads: the invoice has left Needs sending and sits under Awaiting payment with its new amount
  await page.waitForSelector('#invoice-filters .settings-tab[data-filter="needs_sending"]:has-text("(0)")', { timeout: 20000 });
  await page.click('#invoice-filters .settings-tab[data-filter="awaiting"]');
  await page.waitForSelector('tr.invoice-row:has-text("SI9102") td:has-text("$1,760.00")', { timeout: 20000 });
  await shot('list-after-edit');

  // 4. A paid invoice in Xero: Edit is off with its reason, Issue credit note shows for admin
  await page.click('#invoice-filters .settings-tab[data-filter="paid"]');
  await page.click('tr.invoice-row:has-text("SI9103")');
  await page.waitForSelector('#ip-card h2:has-text("SI9103")');
  if (!(await page.locator('#ip-card #ip-edit').isDisabled())) throw new Error('Edit should be off on an invoice in Xero');
  if (!/Edit is off: this invoice is in Xero/.test(await text('#ip-card'))) throw new Error('the reason Edit is off should be shown');
  await page.waitForSelector('#ip-card #ip-credit');
  if (!/Paid in Xero/.test(await text('#ip-card ol'))) throw new Error('SI9103 history should show the payment');
  await shot('panel-paid-in-xero');
  await page.click('#ip-card #ip-close');

  // 5. The job's Invoices tab shows the same words
  await page.goto(`${base}/project.html?id=00000000-0000-4000-c000-000000000002&tab=invoices`, { waitUntil: 'load' });
  await page.waitForSelector('#job-invoices-list .open-invoice-btn', { timeout: 30000 });
  const tab = await text('#job-invoices-list');
  // SI9102 reads Sent, awaiting payment after the step above (Not sent in a harness whose data resets per page)
  if (!/Overdue \d+ day/.test(tab) || !/Paid \d+ \w+/.test(tab) || !/Sent, awaiting payment|Not sent/.test(tab) || !/Emailed to client by Test Sales/.test(tab)) throw new Error('the job tab should show the same status words and last actions');
  await shot('job-invoices-tab');
  await page.locator('#job-invoices-list .open-invoice-btn').first().click();
  await page.waitForSelector('#ip-card ol');
  await shot('job-panel');
  await page.click('#ip-card #ip-close');
  // the Cost Centres tab's claims table opens the same panel
  await page.click('#job-tabs .settings-tab[data-panel="costcentres"]');
  await page.locator('#panel-costcentres .open-invoice-btn').first().click();
  await page.waitForSelector('#ip-card ol');
  await shot('claims-table-panel');
  await page.click('#ip-card #ip-close');
};
