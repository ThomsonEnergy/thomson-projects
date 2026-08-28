// Like requirePricingRole, but narrower - Admin/Finance only, no Sales.
// For anything that reveals a real payroll figure (an individual
// employee's pay rate, or a cost derived closely enough from one person's
// single shift that it amounts to the same thing) rather than just an
// aggregate $ total, which pricing roles broadly can already see.

const { getAdminClient, getAuthCheckClient } = require('./require-admin');

async function requireFinanceRole(event) {
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
  if (!['admin', 'finance'].includes(profile.role)) return null;

  return { supabaseAdmin, user: userData.user };
}

module.exports = { requireFinanceRole };
