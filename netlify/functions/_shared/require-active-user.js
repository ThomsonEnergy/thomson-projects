// Like requireAdmin/requirePricingRole, but for actions any active logged-in
// staff member should be able to trigger - e.g. running AI extraction on a
// licence/insurance document they're uploading themselves. No role
// restriction, just "is this a real, active account".

const { getAdminClient, getAuthCheckClient } = require('./require-admin');

async function requireActiveUser(event) {
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

  return { supabaseAdmin, user: userData.user };
}

module.exports = { requireActiveUser };
