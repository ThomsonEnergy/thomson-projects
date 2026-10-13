// POST /.netlify/functions/sync-overheads   { map: [{ account_id, account_code, account_name, bucket }] }
// Finance and admin only. Saves which Xero expense account belongs to which overhead bucket
// (employee / company / ignore), then rewrites the Xero-sourced overhead lines from the Profit and
// Loss report. With no map in the body it just re-runs the sync with the saved mapping ("Sync now").

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { applyMapping } = require('./_shared/overheads-xero');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const BUCKETS = ['employee', 'company', 'ignore'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireFinanceRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin } = auth;
  try {
    const body = JSON.parse(event.body || '{}');
    if (Array.isArray(body.map)) {
      const rows = body.map
        .filter((m) => m && m.account_id && BUCKETS.includes(m.bucket))
        .map((m) => ({ account_id: String(m.account_id), account_code: m.account_code || null, account_name: String(m.account_name || '').slice(0, 200), bucket: m.bucket, updated_at: new Date().toISOString() }));
      if (rows.length) {
        const { error } = await supabaseAdmin.from('overhead_xero_map').upsert(rows, { onConflict: 'account_id' });
        if (error) throw error;
      }
    }
    const result = await applyMapping(supabaseAdmin);
    return json(result.ok ? 200 : 502, result);
  } catch (err) {
    console.error('sync-overheads failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
