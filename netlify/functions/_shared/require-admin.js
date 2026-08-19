// Shared helper for admin-only Netlify functions.
//
// These functions use the Supabase SERVICE ROLE key, which bypasses RLS
// entirely — so unlike normal client-side queries, RLS can't protect us
// here. Every function that touches user accounts MUST call
// requireAdmin() first and stop if it returns null.

const { createClient } = require('@supabase/supabase-js');

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Verifies the request's bearer token belongs to a logged-in, active
// admin. Returns { supabaseAdmin, user } on success, or null (and the
// caller should respond 401/403) on failure.
async function requireAdmin(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    console.error('requireAdmin: no bearer token in request headers');
    return null;
  }

  const supabaseAdmin = getAdminClient();

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.error('requireAdmin: auth.getUser failed —', userErr?.message || 'no user returned');
    return null;
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role, active')
    .eq('id', userData.user.id)
    .single();

  if (profileErr) {
    console.error('requireAdmin: profile lookup failed for user', userData.user.id, '—', profileErr.message);
    return null;
  }
  if (!profile) {
    console.error('requireAdmin: no profile row found for user', userData.user.id);
    return null;
  }
  if (profile.role !== 'admin') {
    console.error('requireAdmin: user', userData.user.id, 'has role', profile.role, 'not admin');
    return null;
  }
  if (!profile.active) {
    console.error('requireAdmin: user', userData.user.id, 'is marked inactive');
    return null;
  }

  return { supabaseAdmin, user: userData.user };
}

module.exports = { getAdminClient, requireAdmin };
