// Shared helper for admin-only Netlify functions.
//
// These functions use the Supabase SERVICE ROLE key, which bypasses RLS
// entirely — so unlike normal client-side queries, RLS can't protect us
// here. Every function that touches user accounts MUST call
// requireAdmin() first and stop if it returns null.

const { createClient } = require('@supabase/supabase-js');

// Safe to hardcode — this is the same public anon key already embedded in
// the browser at /js/supabase-client.js. RLS is what actually protects
// data, not secrecy of this key.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';

// Server-side clients must disable the browser-oriented session handling
// (autoRefreshToken/persistSession), which supabase-js assumes by default.
// Without this, calls like auth.getUser(token) can throw a misleading
// "Auth session missing!" error even when a valid token is passed in.
const SERVER_CLIENT_OPTS = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, SERVER_CLIENT_OPTS);
}

// A client built with the service-role key can unreliably throw
// "Auth session missing!" when calling auth.getUser(token) — it's a known
// supabase-js quirk. Verifying the JWT works reliably from an anon-keyed
// client instead, since all this call does is check the token's signature
// against the auth server.
function getAuthCheckClient() {
  return createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, SERVER_CLIENT_OPTS);
}

// Verifies the request's bearer token belongs to a logged-in, active
// admin. Returns { supabaseAdmin, user } on success, or null (and the
// caller should respond 401/403) on failure.
async function requireAdmin(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  console.log('requireAdmin: authHeader present?', !!authHeader, '| token length:', token.length, '| looks like a JWT?', token.split('.').length === 3);
  if (!token) {
    console.error('requireAdmin: no bearer token in request headers');
    return null;
  }

  const supabaseAdmin = getAdminClient();
  const authCheckClient = getAuthCheckClient();

  const { data: userData, error: userErr } = await authCheckClient.auth.getUser(token);
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
