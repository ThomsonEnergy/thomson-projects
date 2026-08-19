// POST /api/toggle-user-active
// Body: { id, active }
// Admin-only. Deactivating both bans the account (so they truly can't log
// in, not just a cosmetic flag) and flips profiles.active for the UI.

const { requireAdmin } = require('./_shared/require-admin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
  }
  const { supabaseAdmin, user } = auth;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { id, active } = body;
  if (!id || typeof active !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'id and active (boolean) are required' }) };
  }
  if (id === user.id && !active) {
    return { statusCode: 400, body: JSON.stringify({ error: "You can't deactivate your own account." }) };
  }

  try {
    // ban_duration accepts a duration string; 'none' clears an existing ban.
    const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
      ban_duration: active ? 'none' : '876000h', // ~100 years
    });
    if (banErr) throw banErr;

    const { error: profileErr } = await supabaseAdmin
      .from('profiles')
      .update({ active })
      .eq('id', id);
    if (profileErr) throw profileErr;

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
