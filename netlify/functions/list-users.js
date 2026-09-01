// GET /api/list-users
// Admin-only. Combines Supabase Auth's user list (for email, invite
// status) with the profiles table (for role, active, full_name), since
// that split data can't be joined from the client with the anon key.

const { requireAdmin } = require('./_shared/require-admin');

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
      .select('id, role, active, full_name, xero_employee_id, onboarding_completed_at, xero_payroll_status, xero_payroll_error');
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
    }));

    return { statusCode: 200, body: JSON.stringify({ users }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
