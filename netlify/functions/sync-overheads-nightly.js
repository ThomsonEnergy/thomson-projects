// Scheduled (see netlify.toml): once a day, refreshes the Xero-sourced overhead lines from the Profit
// and Loss report so the overhead rates stay live as the company changes. Does nothing unless
// auto-sync is on and at least one account has been mapped on the Overheads page.

const { getAdminClient } = require('./_shared/require-admin');
const { applyMapping } = require('./_shared/overheads-xero');

exports.handler = async () => {
  try {
    const admin = getAdminClient();
    const { data: settings } = await admin.from('overhead_settings').select('auto_sync').eq('id', 1).single();
    if (!settings || !settings.auto_sync) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'auto sync is off' }) };
    const { count } = await admin.from('overhead_xero_map').select('account_id', { count: 'exact', head: true }).in('bucket', ['employee', 'company']);
    if (!count) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'nothing mapped yet' }) };
    const result = await applyMapping(admin);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('sync-overheads-nightly failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
