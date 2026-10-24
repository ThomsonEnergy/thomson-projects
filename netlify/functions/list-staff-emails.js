// GET /.netlify/functions/list-staff-emails
// Any active logged-in user - the Team page needs everyone's email as a
// clickable mailto: link, but email only lives in Supabase Auth, not the
// profiles table, and that's only readable with the service role (see
// list-users.js, which does the same lookup but is admin-only since it
// also returns invite/sign-in status). Returns nothing except {id, email}
// pairs - no role/invite/sign-in details.

const { requireActiveUser } = require('./_shared/require-active-user');

// Every auth user, page by page (the default is the first 50 only: F36 in docs/BUG_REVIEW_2026-10-23.md).
async function allAuthUsers(supabaseAdmin) {
  const users = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...((data && data.users) || []));
    if (!data || !data.nextPage || !(data.users || []).length) break;
  }
  return users;
}

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
    const authUsers = await allAuthUsers(supabaseAdmin);

    const emails = authUsers.map(u => ({ id: u.id, email: u.email }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, emails }) };
  } catch (err) {
    console.error('list-staff-emails error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
