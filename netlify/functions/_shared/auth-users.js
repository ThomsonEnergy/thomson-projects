// Every login in Supabase Auth (email lives only there, not on profiles), paged. Used by
// list-staff-emails.js (the Team page's mailto links) and the client portal's staff check
// (_shared/portal-session.js). Reads only.
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
