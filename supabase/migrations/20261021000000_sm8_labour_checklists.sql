-- ServiceM8 import: labour timesheets, checklists and staff matches (spec A27).
--
-- sm8-copy-attachments-background.js now also brings across, for every imported
-- ServiceM8 job:
--   * each recorded check-in/check-out (ServiceM8 jobactivity) as a time entry on
--     the job, for the TEops person matched to that ServiceM8 staff member. They
--     were already paid through Xero, so they are marked pushed and never sent
--     again, and they only show on the job (not on anyone's own Timesheets page)
--   * every checklist item, ticked or not, as a task on the job
-- Each ServiceM8 record id is unique here, so the import can be re-run without
-- doubling anything up (plain unique indexes, nulls never clash).
-- profiles.sm8_staff_uuid is the staff match, set on Settings > ServiceM8 Import.
-- sm8_copy_runs keeps each run's summary (counts, staff not matched) for that page.

alter table public.profiles add column if not exists sm8_staff_uuid text;
create unique index if not exists profiles_sm8_staff_uuid_key on public.profiles (sm8_staff_uuid);

alter table public.time_entries add column if not exists sm8_activity_uuid text;
create unique index if not exists time_entries_sm8_activity_uuid_key on public.time_entries (sm8_activity_uuid);

alter table public.job_tasks add column if not exists sm8_checklist_uuid text;
create unique index if not exists job_tasks_sm8_checklist_uuid_key on public.job_tasks (sm8_checklist_uuid);

create table if not exists public.sm8_copy_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create index if not exists sm8_copy_runs_started_at_idx on public.sm8_copy_runs (started_at desc);

-- Written only by the background function (service role); admins read it.
alter table public.sm8_copy_runs enable row level security;
drop policy if exists "Admins read sm8 copy runs" on public.sm8_copy_runs;
create policy "Admins read sm8 copy runs" on public.sm8_copy_runs for select to authenticated
  using ((select is_admin()));

grant select on public.sm8_copy_runs to authenticated;
grant select, insert, update, delete on public.sm8_copy_runs to service_role;
