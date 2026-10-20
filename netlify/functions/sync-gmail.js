// Scheduled (every 5 minutes, see netlify.toml): pulls new mail for
// sales@thomsonenergy.com.au into email_threads / emails. The "Sync now" buttons use
// sync-gmail-now.js instead, because Netlify does not allow a scheduled function to be
// called over HTTP in production. The work itself lives in _shared/gmail-sync.js.

const { runSync } = require('./_shared/gmail-sync');
const { runAgent } = require('./_shared/agent-log');

// Reports to the ops manager (_shared/agent-log.js): only runs that brought mail in are logged.
exports.handler = () => runAgent('sync-gmail', async () => {
  // Netlify's scheduler gives up on a run after 15 seconds and starts it again, so finish well
  // inside that; a sales@ backlog carries on in mailbox-work-background.js
  const result = await runSync({ budgetMs: 10000 });
  return {
    quiet: !result.synced,
    summary: `${result.synced} email${result.synced === 1 ? '' : 's'} synced${result.bills ? `, ${result.bills} supplier bill${result.bills === 1 ? '' : 's'}` : ''}${result.priceLists ? `, ${result.priceLists} possible price list${result.priceLists === 1 ? '' : 's'}` : ''}${result.done ? '' : ' (more next run)'}`,
    details: result,
    response: { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) },
  };
});
