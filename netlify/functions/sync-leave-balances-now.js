const { requireFinanceRole } = require('./_shared/require-finance-role');
const { syncLeaveBalances } = require('./sync-leave-balances');

// POST - the Staff page's "Refresh from Xero" button. Same work as the daily
// sync-leave-balances.js, but callable over HTTP (Netlify does not route HTTP
// calls to a scheduled function in production, see sync-gmail-now.js) and
// limited to finance roles, since it reads payroll data.

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireFinanceRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  try {
    const result = await syncLeaveBalances(auth.supabaseAdmin);
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('sync-leave-balances-now failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
