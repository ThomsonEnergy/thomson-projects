// Scheduled every 15 minutes (netlify.toml): every approved supplier bill or credit note not yet in
// Xero goes up as a Bill (ACCPAY) or supplier credit note (item 83 part C, _shared/push-bill-to-xero.js).
// Off until api_keys xero_bills_push = 'on' (a new integration starts off on production until proven;
// Push to Xero by hand on the supplier page works regardless). Reports to the ops manager
// (_shared/agent-log.js) as the worker 'xero-bills'.

const { runAgent } = require('./_shared/agent-log');
const { getAdminClient } = require('./_shared/require-admin');
const { pushApprovedBills } = require('./_shared/push-bill-to-xero');

exports.handler = () => runAgent('xero-bills', async () => {
  const r = await pushApprovedBills(getAdminClient(), { limit: 20 });
  if (!r.on) return { quiet: true, summary: 'Off (api_keys xero_bills_push is not on)', details: r };
  const parts = [];
  if (r.pushed) parts.push(`${r.pushed} sent to Xero`);
  if (r.failed) parts.push(`${r.failed} could not go: ${r.errors.slice(0, 3).join('; ')}`);
  return { quiet: !r.pushed && !r.failed, summary: parts.length ? parts.join(', ') : 'Nothing waiting', details: r, needsMe: r.failed };
});
