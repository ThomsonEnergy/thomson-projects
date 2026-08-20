// Like requireAdmin, but for actions that any pricing role (Admin/Finance/
// Sales) should be able to trigger - pushing an invoice or timesheets to
// Xero, not just user management.

const { getAdminClient, getAuthCheckClient } = require('./require-admin');

async function requirePricingRole(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const supabaseAdmin = getAdminClient();
  const authCheckClient = getAuthCheckClient();

  const { data: userData, error: userErr } = await authCheckClient.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role, active')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !profile || !profile.active) return null;
  if (!['admin', 'finance', 'sales'].includes(profile.role)) return null;

  return { supabaseAdmin, user: userData.user };
}

module.exports = { requirePricingRole };
