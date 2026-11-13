-- Everyone with a login should be able to see the Team page in full -
-- names, phone numbers, and licences - not just certain roles.
--
-- team.html and its query already have no role restriction at all, and
-- neither does the main nav (the Team link shows for every role). The
-- one place this could actually be locked down is row-level security on
-- profile_licences - a table that predates any committed migration
-- (created directly against the live database), so its current policy
-- is opaque here.
--
-- Rather than guessing that policy's name to alter it, this just adds
-- one more broad permissive policy alongside whatever's already there -
-- Postgres ORs permissive policies of the same command together, so
-- this alone guarantees every authenticated user can read every row,
-- regardless of what else is already in place. Only touches SELECT -
-- who can add/edit/delete a licence record is unchanged.

alter table profile_licences enable row level security;
drop policy if exists "staff can view all profile licences" on profile_licences;
create policy "staff can view all profile licences"
  on profile_licences for select to authenticated using (true);
