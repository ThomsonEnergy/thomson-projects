-- Fixes: a non-admin account only seeing themselves on the Team page,
-- instead of every active team member.
--
-- migration_058 opened up profile_licences, but the actual restriction was
-- one level up: row-level security on `profiles` itself only allowing a
-- user to read their own row (auth.uid() = id) for at least some roles.
-- Team.html (and several other pages - task assignment, schedule, PO
-- pickers) all query `profiles` broadly expecting to see every active
-- staff member, not just the caller.
--
-- Adds one more broad permissive SELECT policy, same reasoning as
-- migration_058: Postgres ORs permissive policies together, so this
-- guarantees every authenticated user can see every profile ROW,
-- regardless of whatever policy is already there.
--
-- IMPORTANT - this only affects ROW visibility, not column visibility.
-- If `profiles.ordinary_rate` / `rate_1_5x` / `rate_2x` (actual pay rates)
-- are meant to stay hidden from non-admin/finance roles, that needs to be
-- enforced separately - either a column-level REVOKE, or by never
-- selecting those columns from a page a non-pricing/non-admin role can
-- open. This migration does not touch that; check it separately before
-- assuming pay rates are still protected after running this.

alter table profiles enable row level security;
drop policy if exists "staff can view all profiles" on profiles;
create policy "staff can view all profiles"
  on profiles for select to authenticated using (true);
