-- Migration 013 — Timesheets (clock in/out), leave requests, staff schedule
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- None of this depends on Xero. Time entries and leave sit here natively;
-- pushing them to Xero Payroll as DRAFT is a separate, later step once
-- Xero's OAuth app is actually set up.

-- 1. Time entries (clock in / clock out) -----------------------------------

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id),   -- null = general/office time, not job-specific
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

alter table time_entries enable row level security;

drop policy if exists "Staff can manage own time entries" on time_entries;
create policy "Staff can manage own time entries" on time_entries
  for all using (auth.uid() = staff_id) with check (auth.uid() = staff_id);

drop policy if exists "Pricing roles can view all time entries" on time_entries;
create policy "Pricing roles can view all time entries" on time_entries
  for select using (is_pricing_role());

drop policy if exists "Pricing roles can correct time entries" on time_entries;
create policy "Pricing roles can correct time entries" on time_entries
  for update using (is_pricing_role());

-- 2. Leave requests ---------------------------------------------------------

create table if not exists leave_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  leave_type text not null default 'annual',
  notes text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz
);

alter table leave_requests
  drop constraint if exists leave_requests_type_check;
alter table leave_requests
  add constraint leave_requests_type_check
  check (leave_type in ('annual', 'sick', 'unpaid', 'other'));

alter table leave_requests
  drop constraint if exists leave_requests_status_check;
alter table leave_requests
  add constraint leave_requests_status_check
  check (status in ('pending', 'approved', 'declined'));

alter table leave_requests enable row level security;

drop policy if exists "Staff can manage own leave requests" on leave_requests;
create policy "Staff can manage own leave requests" on leave_requests
  for all using (auth.uid() = staff_id) with check (auth.uid() = staff_id);

drop policy if exists "Admins can view and decide all leave requests" on leave_requests;
create policy "Admins can view and decide all leave requests" on leave_requests
  for select using (is_admin() or is_pricing_role());

drop policy if exists "Admins can decide leave requests" on leave_requests;
create policy "Admins can decide leave requests" on leave_requests
  for update using (is_admin());

-- 3. Staff schedule (who's assigned to which job, which day) --------------

create table if not exists schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id),
  assignment_date date not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table schedule_assignments enable row level security;

-- Everyone can see the schedule — useful for coordination even if you're
-- not the one assigning people to jobs.
drop policy if exists "Authenticated can view schedule" on schedule_assignments;
create policy "Authenticated can view schedule" on schedule_assignments
  for select using (auth.uid() is not null);

drop policy if exists "Pricing roles can manage schedule" on schedule_assignments;
create policy "Pricing roles can manage schedule" on schedule_assignments
  for all using (is_pricing_role()) with check (is_pricing_role());
