-- Job title (e.g. "Licensed Electrician", "Office Manager") is a
-- separate concept from the system access role (admin/finance/sales/
-- staff) - shown on the Team page instead of the access role, editable
-- only by admin or finance.
alter table profiles add column if not exists job_title text;

-- "Admins can update any profile" (migration_007) only covers admin -
-- finance needs the same for editing someone else's job_title.
drop policy if exists "Finance can update any profile" on profiles;
create policy "Finance can update any profile"
  on profiles for update
  using (current_profile_role() = 'finance')
  with check (current_profile_role() = 'finance');
