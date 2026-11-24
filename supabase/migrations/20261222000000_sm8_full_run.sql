-- Item 111, leave ServiceM8 for good: one run brings every client, quote, Work Order job and
-- Completed job across (netlify/functions/_shared/sm8-run.js). Additions only.
--
-- sm8_runs          one row per press of Dry run or Bring everything across: where it is up to.
-- sm8_run_clients   one row per ServiceM8 client: the TEops client it became.
-- sm8_run_jobs      one row per ServiceM8 job that comes across, with the full ServiceM8 record
--                   (payload: the job, its lines, notes, payments, contacts, check-ins, checklist
--                   and file list) kept as the raw copy once ServiceM8 is closed.
-- sm8_attachment_copies gains the file's own ServiceM8 date and person, so the copy step no
--                   longer has to ask ServiceM8 for them.
-- sm8_run_report()  the check report: ServiceM8 counts against what is in TEops.
--
-- Written only by the server (service role). Admins read them.

create table if not exists public.sm8_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('dry_run', 'full')),
  status text not null default 'listing' check (status in ('listing', 'listed', 'running', 'paused', 'done', 'failed')),
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  resume_after timestamptz,
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error text
);
create index if not exists sm8_runs_started_at_idx on public.sm8_runs (started_at desc);
create index if not exists sm8_runs_started_by_idx on public.sm8_runs (started_by);

create table if not exists public.sm8_run_clients (
  sm8_company_uuid text primary key,
  name text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  client_id uuid references public.clients(id) on delete set null,
  made_new boolean not null default false,
  reason text,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists sm8_run_clients_status_idx on public.sm8_run_clients (status);
create index if not exists sm8_run_clients_client_id_idx on public.sm8_run_clients (client_id);

create table if not exists public.sm8_run_jobs (
  sm8_job_uuid text primary key,
  sm8_job_number text,
  kind text not null check (kind in ('quote', 'job', 'completed')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  project_id uuid references public.projects(id) on delete set null,
  stats jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists sm8_run_jobs_status_idx on public.sm8_run_jobs (status);
create index if not exists sm8_run_jobs_project_id_idx on public.sm8_run_jobs (project_id);

alter table public.sm8_attachment_copies add column if not exists sm8_created_at timestamptz;
alter table public.sm8_attachment_copies add column if not exists sm8_staff_uuid text;
create index if not exists sm8_attachment_copies_project_id_idx on public.sm8_attachment_copies (project_id);

alter table public.sm8_runs enable row level security;
alter table public.sm8_run_clients enable row level security;
alter table public.sm8_run_jobs enable row level security;

drop policy if exists "Admins read sm8 runs" on public.sm8_runs;
create policy "Admins read sm8 runs" on public.sm8_runs for select to authenticated
  using ((select is_admin()));
drop policy if exists "Admins read sm8 run clients" on public.sm8_run_clients;
create policy "Admins read sm8 run clients" on public.sm8_run_clients for select to authenticated
  using ((select is_admin()));
drop policy if exists "Admins read sm8 run jobs" on public.sm8_run_jobs;
create policy "Admins read sm8 run jobs" on public.sm8_run_jobs for select to authenticated
  using ((select is_admin()));

grant select on public.sm8_runs, public.sm8_run_clients, public.sm8_run_jobs to authenticated;
grant select, insert, update, delete on public.sm8_runs, public.sm8_run_clients, public.sm8_run_jobs to service_role;

-- The check report. Everything ServiceM8 holds (as listed by the last run) against what is in
-- TEops now. "missing" has to read zero before ServiceM8 is cancelled.
create or replace function public.sm8_run_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  with j as (
    select r.sm8_job_uuid, r.sm8_job_number, r.kind, r.status, r.project_id, r.error, r.stats, r.warnings,
           p.job_number, p.quote_number, p.client_name
    from sm8_run_jobs r left join projects p on p.id = r.project_id
  ),
  f as (
    select c.project_id,
           count(*) filter (where c.status = 'copied') as copied,
           count(*) filter (where c.status = 'failed') as failed,
           count(*) filter (where c.status in ('pending', 'copying')) as waiting
    from sm8_attachment_copies c group by c.project_id
  ),
  t as (
    select e.project_id, sum(extract(epoch from (e.clock_out - e.clock_in)) / 3600.0) as hours
    from time_entries e where e.sm8_activity_uuid is not null and e.clock_out is not null group by e.project_id
  ),
  per_project as (
    select j.project_id, min(j.sm8_job_number) as sm8_job_number, min(j.job_number) as job_number, min(j.quote_number) as quote_number,
           sum(coalesce((j.stats->>'files')::int, 0)) as files_expected,
           sum(coalesce((j.stats->>'hoursMatched')::numeric, 0)) as hours_expected
    from j where j.project_id is not null group by j.project_id
  )
  select jsonb_build_object(
    'jobs', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select kind || ':' || status as k, count(*) as n from j group by 1) x),
    'jobsTotal', (select count(*) from j),
    'jobsMissing', (select count(*) from j where status <> 'done' or project_id is null),
    'missingJobs', (select coalesce(jsonb_agg(jsonb_build_object('number', sm8_job_number, 'kind', kind, 'error', coalesce(error, 'Not brought across yet')) order by sm8_job_number), '[]'::jsonb)
                    from (select * from j where status <> 'done' or project_id is null order by sm8_job_number limit 300) x),
    'clients', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) as n from sm8_run_clients group by 1) x),
    'clientsNew', (select count(*) from sm8_run_clients where made_new),
    'clientsToCheck', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'reason', reason, 'clientId', client_id) order by name), '[]'::jsonb)
                       from (select * from sm8_run_clients where made_new and reason is not null order by name limit 300) x),
    'clientsFailed', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'error', error) order by name), '[]'::jsonb)
                      from (select * from sm8_run_clients where status = 'failed' order by name limit 300) x),
    'filesExpected', (select coalesce(sum(files_expected), 0) from per_project),
    'filesCopied', (select coalesce(sum(copied), 0) from f),
    'filesFailed', (select coalesce(sum(failed), 0) from f),
    'filesWaiting', (select coalesce(sum(waiting), 0) from f),
    'failedFiles', (select coalesce(jsonb_agg(jsonb_build_object('file', file_name, 'error', error, 'projectId', project_id, 'jobNumber', job_number, 'quoteNumber', quote_number)), '[]'::jsonb)
                    from (select c.file_name, c.error, c.project_id, p.job_number, p.quote_number
                          from sm8_attachment_copies c join projects p on p.id = c.project_id where c.status = 'failed' order by c.created_at limit 300) x),
    'jobsShortOfFiles', (select coalesce(jsonb_agg(jsonb_build_object('projectId', pp.project_id, 'number', pp.sm8_job_number, 'jobNumber', pp.job_number, 'quoteNumber', pp.quote_number,
                                 'expected', pp.files_expected, 'copied', coalesce(f.copied, 0))), '[]'::jsonb)
                         from (select * from per_project order by sm8_job_number limit 100000) pp left join f on f.project_id = pp.project_id
                         where coalesce(f.copied, 0) < pp.files_expected),
    'hoursInServiceM8', (select round(coalesce(sum((stats->>'hoursSeen')::numeric), 0), 1) from j),
    'hoursNoLogin', (select round(coalesce(sum((stats->>'hoursUnmatched')::numeric), 0), 1) from j),
    'hoursBrought', (select round(coalesce(sum(t.hours), 0)::numeric, 1) from t where t.project_id in (select project_id from per_project)),
    'jobsShortOfHours', (select coalesce(jsonb_agg(jsonb_build_object('projectId', pp.project_id, 'number', pp.sm8_job_number, 'jobNumber', pp.job_number,
                                 'expected', round(pp.hours_expected, 1), 'brought', round(coalesce(t.hours, 0)::numeric, 1))), '[]'::jsonb)
                         from per_project pp left join t on t.project_id = pp.project_id
                         where coalesce(t.hours, 0) < pp.hours_expected - 0.1),
    'owing', (select coalesce(jsonb_agg(jsonb_build_object('number', sm8_job_number, 'projectId', project_id, 'jobNumber', job_number, 'client', client_name, 'owing', (stats->>'owing')::numeric)
                              order by (stats->>'owing')::numeric desc), '[]'::jsonb)
              from (select * from j where kind = 'completed' and coalesce((stats->>'owing')::numeric, 0) > 0.5 order by (stats->>'owing')::numeric desc limit 500) x),
    'owingTotal', (select round(coalesce(sum((stats->>'owing')::numeric), 0), 2) from j where kind = 'completed' and coalesce((stats->>'owing')::numeric, 0) > 0.5),
    'warnings', (select coalesce(jsonb_agg(jsonb_build_object('number', sm8_job_number, 'projectId', project_id, 'jobNumber', job_number, 'quoteNumber', quote_number, 'warnings', warnings)), '[]'::jsonb)
                 from (select * from j where jsonb_array_length(warnings) > 0 order by sm8_job_number limit 300) x),
    'warningsTotal', (select count(*) from j where jsonb_array_length(warnings) > 0)
  ) into v;
  return v;
end;
$$;

revoke execute on function public.sm8_run_report() from public, anon;
grant execute on function public.sm8_run_report() to authenticated;
