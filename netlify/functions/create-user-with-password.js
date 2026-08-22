// POST /api/create-user-with-password
// Body: { email, full_name, role, password }
// Admin-only. Creates the auth user directly with a password the admin
// sets and gives to them out of band - for when invite emails aren't
// reliably arriving. Skips the email confirmation flow entirely
// (email_confirm: true), so they can log in immediately with it.

const { requireAdmin } = require('./_shared/require-admin');

const VALID_ROLES = ['admin', 'finance', 'sales', 'staff'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
  }
  const { supabaseAdmin } = auth;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const email = (body.email || '').trim().toLowerCase();
  const fullName = (body.full_name || '').trim();
  const role = body.role;
  const password = body.password || '';

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
  }
  if (!VALID_ROLES.includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid role' }) };
  }
  if (!password || password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  try {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr) throw createErr;

    const { error: profileErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: created.user.id, role, full_name: fullName, active: true });
    if (profileErr) throw profileErr;

    return { statusCode: 200, body: JSON.stringify({ success: true, id: created.user.id }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
