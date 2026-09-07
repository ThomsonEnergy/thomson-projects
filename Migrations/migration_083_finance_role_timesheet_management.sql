-- Migration 083 — Finance-role timesheet management
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Admin/finance need to add and remove time_entries rows for OTHER staff
-- (splitting a block across stages, adding a missed entry, removing one)
-- from the new all-employees timesheet dashboard - not just their own.
-- time_entries already has SELECT and UPDATE policies for the broader
-- "pricing role" group (admin/finance/sales, is_pricing_role()), but no
-- INSERT/DELETE policy lets anyone touch a row that isn't their own
-- except that same pricing-role UPDATE. Scoped narrower than
-- is_pricing_role() (admin+finance only, no sales) since this is actual
-- payroll record-keeping, not just viewing/correcting.

create or replace function is_finance_role()
returns boolean
language sql
stable
security definer
as $$
  select coalesce((select role from profiles where id = auth.uid()) in ('admin', 'finance'), false);
$$;

create policy "Finance roles can add time entries for staff"
  on time_entries for insert
  with check (is_finance_role());

create policy "Finance roles can delete time entries for staff"
  on time_entries for delete
  using (is_finance_role());
