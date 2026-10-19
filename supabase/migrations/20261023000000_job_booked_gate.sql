-- Job Booked gate: a job is only in Job Booked when someone is scheduled to it (a 'job' block
-- today or later, Sydney time) or someone is clocked into it right now.
-- * A new job inserted as job_booked with neither (Quick Job, Warranty Job, ServiceM8 import)
--   starts at Ready to Book instead.
-- * Moving a job into Job Booked by hand without either is refused with a clear message.
-- * A booking or clock-in on a Ready to Book job moves it to Job Booked.
-- * Removing or moving the last booking (nobody clocked in) moves it back to Ready to Book,
--   or Awaiting Action if required-before-scheduling tasks are still open.
-- * Clocking out does not move it back: the clock-out "How's the job?" step decides.

create or replace function public.project_is_booked(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.schedule_assignments s
    where s.project_id = p_project_id and s.block_type = 'job'
      and s.assignment_date >= (now() at time zone 'Australia/Sydney')::date
  ) or exists (
    select 1 from public.time_entries t
    where t.project_id = p_project_id and t.clock_out is null
  );
$$;

create or replace function public.project_unbooked_stage(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.job_tasks jt
    where jt.project_id = p_project_id and jt.required_before_scheduling = true and jt.completed = false
  ) then 'awaiting_action' else 'ready_to_book' end;
$$;

revoke all on function public.project_is_booked(uuid) from public, anon;
revoke all on function public.project_unbooked_stage(uuid) from public, anon;

-- Moves one job between Ready to Book and Job Booked to match its bookings and clock-ins.
-- p_allow_unbook false = only promote (used on clock-in/out, see header).
create or replace function public.sync_project_booked(p_project_id uuid, p_allow_unbook boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage text;
begin
  if p_project_id is null then return; end if;
  select pipeline_stage into v_stage from public.projects where id = p_project_id;
  if v_stage = 'ready_to_book' and public.project_is_booked(p_project_id) then
    update public.projects set pipeline_stage = 'job_booked' where id = p_project_id and pipeline_stage = 'ready_to_book';
  elsif v_stage = 'job_booked' and p_allow_unbook and not public.project_is_booked(p_project_id) then
    update public.projects set pipeline_stage = public.project_unbooked_stage(p_project_id)
      where id = p_project_id and pipeline_stage = 'job_booked';
  end if;
end;
$$;

revoke all on function public.sync_project_booked(uuid, boolean) from public, anon, authenticated;

create or replace function public.projects_job_booked_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pipeline_stage = 'job_booked'
     and (tg_op = 'INSERT' or old.pipeline_stage is distinct from 'job_booked') then
    if tg_op = 'INSERT' then
      -- Nothing can be scheduled or clocked in against a row that does not exist yet.
      new.pipeline_stage := 'ready_to_book';
    elsif not public.project_is_booked(new.id) then
      raise exception 'Schedule someone or clock in first: a job is only Job Booked when someone is scheduled to it or clocked into it.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_job_booked_gate on public.projects;
create trigger projects_job_booked_gate
  before insert or update of pipeline_stage on public.projects
  for each row execute function public.projects_job_booked_gate();

create or replace function public.schedule_assignments_sync_booked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.sync_project_booked(new.project_id, true);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.project_id is distinct from new.project_id) then
    perform public.sync_project_booked(old.project_id, true);
  end if;
  return null;
end;
$$;

drop trigger if exists schedule_assignments_sync_booked on public.schedule_assignments;
create trigger schedule_assignments_sync_booked
  after insert or update or delete on public.schedule_assignments
  for each row execute function public.schedule_assignments_sync_booked();

-- Clock-ins only promote. Deleting an open clock-in can move it back.
create or replace function public.time_entries_sync_booked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.sync_project_booked(new.project_id, false);
  end if;
  if tg_op = 'DELETE' and old.clock_out is null then
    perform public.sync_project_booked(old.project_id, true);
  elsif tg_op = 'UPDATE' and old.project_id is distinct from new.project_id and old.clock_out is null then
    perform public.sync_project_booked(old.project_id, true);
  end if;
  return null;
end;
$$;

drop trigger if exists time_entries_sync_booked on public.time_entries;
create trigger time_entries_sync_booked
  after insert or update or delete on public.time_entries
  for each row execute function public.time_entries_sync_booked();

revoke all on function public.projects_job_booked_gate() from public, anon, authenticated;
revoke all on function public.schedule_assignments_sync_booked() from public, anon, authenticated;
revoke all on function public.time_entries_sync_booked() from public, anon, authenticated;

-- One-off: jobs already in Job Booked with nobody scheduled or clocked in (J7003 on 18 Oct 2026).
update public.projects p
  set pipeline_stage = public.project_unbooked_stage(p.id)
  where p.pipeline_stage = 'job_booked' and not public.project_is_booked(p.id);
