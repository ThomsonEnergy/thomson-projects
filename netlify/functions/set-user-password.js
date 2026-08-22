// POST /api/set-user-password
// Body: { id, password }
// Admin-only. Directly sets a password for an existing user - for when
// invite/reset emails aren't arriving reliably. The admin gives the new
// password to the person themselves.

const { requireAdmin } = require('./_shared/require-admin');

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

  const { id, password } = body;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
  }
  if (!password || password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
