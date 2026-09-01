// POST /api/invite-user
// Body: { email, full_name, role, rate_tier_id?, ordinary_rate?, rate_1_5x?, rate_2x?, rate_2_5x? }
// Admin-only. Sends a Supabase invite email and creates the matching
// profiles row so the role (and pay rates, if given up front) are set
// before the person ever logs in.

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

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
  }
  if (!VALID_ROLES.includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid role' }) };
  }

  try {
    const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });
    if (inviteErr) throw inviteErr;

    const { error: profileErr } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: invited.user.id, role, full_name: fullName, active: true,
        rate_tier_id: body.rate_tier_id || null,
        ordinary_rate: parseFloat(body.ordinary_rate) || null,
        rate_1_5x: parseFloat(body.rate_1_5x) || null,
        rate_2x: parseFloat(body.rate_2x) || null,
        rate_2_5x: parseFloat(body.rate_2_5x) || null,
      });
    if (profileErr) throw profileErr;

    return { statusCode: 200, body: JSON.stringify({ success: true, id: invited.user.id }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
