// Scheduled (see netlify.toml): once a day, refreshes the Xero-sourced overhead lines from the Profit
// and Loss report so the overhead rates stay live as the company changes. Does nothing unless
// auto-sync is on and at least one account has been mapped on the Overheads page.

const { getAdminClient } = require('./_shared/require-admin');
const { applyMapping } = require('./_shared/overheads-xero');
const { runAgent } = require('./_shared/agent-log');

// Reports to the ops manager (_shared/agent-log.js).
exports.handler = () => runAgent('sync-overheads-nightly', async () => {
  const admin = getAdminClient();
  const { data: settings } = await admin.from('overhead_settings').select('auto_sync').eq('id', 1).single();
  if (!settings || !settings.auto_sync) return { quiet: true, response: { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'auto sync is off' }) } };
  const { count } = await admin.from('overhead_xero_map').select('account_id', { count: 'exact', head: true }).in('bucket', ['employee', 'company']);
  if (!count) return { quiet: true, response: { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'nothing mapped yet' }) } };
  const result = await applyMapping(admin);
  return { summary: 'Overheads refreshed from Xero', details: result, response: { statusCode: 200, body: JSON.stringify(result) } };
});
