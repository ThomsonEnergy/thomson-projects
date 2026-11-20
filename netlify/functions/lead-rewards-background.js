// Scheduled every 15 minutes (netlify.toml): lead rewards that are owed become Xero credit notes, come
// off the referrer's oldest unpaid invoice and are allocated in Xero; a reward that stepped off an
// invoice has its Xero allocation removed; the referrer is emailed once (backlog item 74b, step 3b part
// 2, _shared/lead-rewards.js). Does nothing until the Lead rewards row in Settings > Xero Mapping has an
// account. Reports to the ops manager (_shared/agent-log.js) as the worker 'lead-rewards'.

const { runAgent } = require('./_shared/agent-log');
const { getAdminClient } = require('./_shared/require-admin');
const { runLeadRewards } = require('./_shared/lead-rewards');

exports.handler = () => runAgent('lead-rewards', async () => {
  const r = await runLeadRewards(getAdminClient(), { limit: 20 });
  if (!r.on) return { quiet: true, summary: 'Off (no account on the Lead rewards row in Settings > Xero Mapping)', details: r };
  const parts = [];
  if (r.raised) parts.push(`${r.raised} credit note${r.raised === 1 ? '' : 's'} raised in Xero`);
  if (r.placed) parts.push(`${r.placed} taken off an invoice`);
  if (r.allocated) parts.push(`${r.allocated} allocated in Xero`);
  if (r.steppedOff) parts.push(`${r.steppedOff} stepped off an invoice`);
  if (r.closed) parts.push(`${r.closed} closed by what Xero shows`);
  if (r.told) parts.push(`${r.told} referrer${r.told === 1 ? '' : 's'} told`);
  if (r.failed) parts.push(`${r.failed} could not go: ${r.errors.slice(0, 3).join('; ')}`);
  return { quiet: !parts.length, summary: parts.length ? parts.join(', ') : 'Nothing waiting', details: r, needsMe: r.failed };
});
