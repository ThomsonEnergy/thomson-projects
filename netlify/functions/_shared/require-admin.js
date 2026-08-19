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
  if (!token) return null;

  const supabaseAdmin = getAdminClient();

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role, active')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !profile || profile.role !== 'admin' || !profile.active) return null;

  return { supabaseAdmin, user: userData.user };
}

module.exports = { getAdminClient, requireAdmin };
