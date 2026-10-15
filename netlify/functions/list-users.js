// GET /api/list-users
// Admin-only. Combines Supabase Auth's user list (for email, invite
// status) with the profiles table (for role, active, full_name), since
// that split data can't be joined from the client with the anon key.

const { requireAdmin } = require('./_shared/require-admin');

// Whether the 4 pay rates on the profile match what was last pushed to
// Xero (push-pay-rates-to-xero.js), so a pay rise not yet sent is flagged.
function ratesStatus(p) {
  if (!p) return null;
  if (![p.ordinary_rate, p.rate_1_5x, p.rate_2x, p.rate_2_5x].some(v => Number(v) > 0)) return 'no_rates';
  if (!p.xero_rates_pushed) return 'never';
  // Public holiday goes to Xero as the penalty only (base + penalty split,
  // migration 152), worked out the same way push-pay-rates-to-xero.js does.
  const phPenalty = (Number(p.rate_2_5x) > 0 && Number(p.ordinary_rate) > 0) ? Math.round((p.rate_2_5x - p.ordinary_rate) * 100) / 100 : 0;
  const now = { ordinary: p.ordinary_rate, ot1: p.rate_1_5x, ot2: p.rate_2x, publicHoliday: phPenalty };
  const same = Object.keys(now).every(k => !(Number(now[k]) > 0) || Number(now[k]) === Number(p.xero_rates_pushed[k]));
  return same ? 'in_xero' : 'changed';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { data: authList, error: authErr } = await supabaseAdmin.auth.admin.listUsers();
    if (authErr) throw authErr;

    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, active, full_name, xero_employee_id, onboarding_completed_at, xero_payroll_status, xero_payroll_error, ordinary_rate, rate_1_5x, rate_2x, rate_2_5x, xero_rates_pushed, xero_rates_pushed_at');
    if (profileErr) throw profileErr;

    const profileById = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    const users = authList.users.map(u => ({
      id: u.id,
      email: u.email,
      invited_at: u.invited_at || u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      confirmed: !!u.email_confirmed_at,
      full_name: profileById[u.id]?.full_name || u.user_metadata?.full_name || '',
      role: profileById[u.id]?.role || 'staff',
      xero_employee_id: profileById[u.id]?.xero_employee_id || '',
      active: profileById[u.id]?.active ?? true,
      onboarding_completed_at: profileById[u.id]?.onboarding_completed_at || null,
      xero_payroll_status: profileById[u.id]?.xero_payroll_status || 'pending',
      xero_payroll_error: profileById[u.id]?.xero_payroll_error || '',
      // Only a status leaves this function, never the rates themselves.
      xero_rates_status: ratesStatus(profileById[u.id]),
      xero_rates_pushed_at: profileById[u.id]?.xero_rates_pushed_at || null,
    }));

    return { statusCode: 200, body: JSON.stringify({ users }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
