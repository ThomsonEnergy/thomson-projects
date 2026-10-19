-- Nightly sweep for the Job Booked gate (migration 20261023000000). The gate only re-checks a job
-- when something on it changes, so a booking that slips into the past (nobody turned up, nobody
-- moved it) would leave the job in Job Booked. sweep-job-booked.js calls this just after midnight
-- Sydney time: any Job Booked job with no booking today or later and nobody clocked in moves back
-- to Ready to Book (or Awaiting Action if required tasks are open). Returns the jobs it moved.

create or replace function public.sweep_job_booked()
returns table (job_number integer, new_stage text)
language sql
security definer
set search_path = public
as $$
  update public.projects p
    set pipeline_stage = public.project_unbooked_stage(p.id)
    where p.pipeline_stage = 'job_booked' and not public.project_is_booked(p.id)
    returning p.job_number, p.pipeline_stage;
$$;

revoke all on function public.sweep_job_booked() from public, anon, authenticated;
grant execute on function public.sweep_job_booked() to service_role;
