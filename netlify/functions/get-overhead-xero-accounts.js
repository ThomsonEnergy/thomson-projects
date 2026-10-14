// GET /.netlify/functions/get-overhead-xero-accounts
// Finance and admin only. Lists every expense account on the last N months of the Xero Profit and
// Loss (N from overhead_settings.xero_months) with its amount and the bucket it is currently mapped
// to, so the Overheads page can offer "employee / company / ignore" for each.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { fetchPnlAccounts, friendlyXeroError } = require('./_shared/overheads-xero');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireFinanceRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin } = auth;
  try {
    const { data: settings } = await supabaseAdmin.from('overhead_settings').select('xero_months').eq('id', 1).single();
    const months = (settings && settings.xero_months) || 12;
    const report = await fetchPnlAccounts(months);
    const { data: map } = await supabaseAdmin.from('overhead_xero_map').select('account_id, bucket');
    const bucketOf = new Map((map || []).map((m) => [m.account_id, m.bucket]));
    const accounts = report.accounts.map((a) => ({ ...a, bucket: bucketOf.get(a.id) || 'ignore' }));
    return json(200, { ok: true, from: report.from, to: report.to, months, accounts });
  } catch (err) {
    console.error('get-overhead-xero-accounts failed:', err.message);
    return json(502, { ok: false, error: friendlyXeroError(err) });
  }
};
