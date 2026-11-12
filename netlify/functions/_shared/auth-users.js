// Every login in Supabase Auth (email lives only there, not on profiles), paged: listUsers gives
// 50 a page by default, so past 50 accounts people silently vanished from Users & Roles (F36 in
// docs/BUG_REVIEW_2026-10-23.md). Used by list-users.js, sm8-staff.js, list-staff-emails.js and
// the client portal's staff check (_shared/portal-session.js). Reads only.
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

module.exports = { allAuthUsers };
