// GET /.netlify/functions/list-staff-emails
// Any active logged-in user - the Team page needs everyone's email as a
// clickable mailto: link, but email only lives in Supabase Auth, not the
// profiles table, and that's only readable with the service role (see
// list-users.js, which does the same lookup but is admin-only since it
// also returns invite/sign-in status). Returns nothing except {id, email}
// pairs - no role/invite/sign-in details.

const { requireActiveUser } = require('./_shared/require-active-user');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { data: authList, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) throw error;

    const emails = authList.users.map(u => ({ id: u.id, email: u.email }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, emails }) };
  } catch (err) {
    console.error('list-staff-emails error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
