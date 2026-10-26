-- Leave to Xero and a leave list people can trust (owner, 26 Oct 2026).
--
-- Sections
--   1  leave_requests: what was sent to Xero (leave application id, when, the hours Xero worked out)
--   2  company_settings: the Xero leave type for annual, sick and unpaid leave (Settings > Xero Mapping)
--   3  Staff policies split: a person can add and change their own request only while it is pending, and
--      never set its status, who decided it or the Xero columns (the old "for all" policy let a person
--      approve their own request through the API). Admin and Finance policies are unchanged.
--   4  Date sanity: one request had an end date in the year 32026

-- 1. What went to Xero
alter table public.leave_requests
  add column if not exists xero_leave_application_id text,
  add column if not exists xero_pushed_at timestamptz,
  add column if not exists xero_units numeric;

-- 2. Xero leave types (blank = matched by name on first use, see push-timesheets-to-xero.js)
alter table public.company_settings
  add column if not exists xero_annual_leave_type_id text,
  add column if not exists xero_sick_leave_type_id text,
  add column if not exists xero_unpaid_leave_type_id text;

-- 3. Staff policies
drop policy if exists "Staff can manage own leave requests" on public.leave_requests;

drop policy if exists "Staff can view own leave requests" on public.leave_requests;
create policy "Staff can view own leave requests" on public.leave_requests for select to authenticated
  using (staff_id = (select auth.uid()));

drop policy if exists "Staff can request leave" on public.leave_requests;
create policy "Staff can request leave" on public.leave_requests for insert to authenticated
  with check (staff_id = (select auth.uid()) and status = 'pending' and decided_by is null and decided_at is null
    and xero_leave_application_id is null and xero_pushed_at is null and xero_units is null);

drop policy if exists "Staff can change own pending leave" on public.leave_requests;
create policy "Staff can change own pending leave" on public.leave_requests for update to authenticated
  using (staff_id = (select auth.uid()) and status = 'pending')
  with check (staff_id = (select auth.uid()) and status = 'pending' and decided_by is null and decided_at is null
    and xero_leave_application_id is null and xero_pushed_at is null and xero_units is null);

drop policy if exists "Staff can withdraw own pending leave" on public.leave_requests;
create policy "Staff can withdraw own pending leave" on public.leave_requests for delete to authenticated
  using (staff_id = (select auth.uid()) and status = 'pending');

-- 4. Dates that make sense (a typed year of 32026 got through on 13 Oct 2026)
update public.leave_requests set end_date = start_date where end_date > date '2100-12-31';
update public.leave_requests set start_date = end_date where start_date < date '2020-01-01';
alter table public.leave_requests drop constraint if exists leave_requests_dates_sane;
alter table public.leave_requests add constraint leave_requests_dates_sane
  check (start_date >= date '2020-01-01' and end_date <= date '2100-12-31' and end_date >= start_date);
