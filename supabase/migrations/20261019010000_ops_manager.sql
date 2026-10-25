-- Ops manager, version 1 (docs/AI_AGENTS_PLAN.md).
--
-- Workers (the supplier bill reader, the email sync, the nightly jobs) report
-- here through netlify/functions/_shared/agent-log.js:
--   agent_heartbeats  one row per worker: when it last worked and last failed;
--   agent_runs        what a worker did on a run that did something (or failed);
--   agent_tasks       things a worker needs a person for (the "Needs me" list).
-- The Ops page (ops.html), the 5am digest (ops-digest.js) and the assistant
-- read them. Admin only. Rows are written by the server (service role).

create table if not exists public.agent_heartbeats (
  agent text primary key,
  label text not null,
  expected_every_minutes integer not null default 60,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'ok',
  summary text,
  details jsonb,
  needs_me integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  constraint agent_runs_status_check check (status in ('ok', 'failed'))
);

create index if not exists agent_runs_started_at_idx on public.agent_runs (started_at desc);
create index if not exists agent_runs_agent_started_at_idx on public.agent_runs (agent, started_at desc);

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  title text not null,
  body text,
  link text,
  status text not null default 'open',
  dedupe_key text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  constraint agent_tasks_status_check check (status in ('open', 'done', 'dismissed'))
);

create unique index if not exists agent_tasks_open_dedupe_idx on public.agent_tasks (dedupe_key) where status = 'open' and dedupe_key is not null;
create index if not exists agent_tasks_status_idx on public.agent_tasks (status, created_at desc);
create index if not exists agent_tasks_resolved_by_idx on public.agent_tasks (resolved_by);

alter table public.agent_heartbeats enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_tasks enable row level security;

drop policy if exists "Admins read agent heartbeats" on public.agent_heartbeats;
create policy "Admins read agent heartbeats" on public.agent_heartbeats for select to authenticated
  using ((select is_admin()));
drop policy if exists "Admins read agent runs" on public.agent_runs;
create policy "Admins read agent runs" on public.agent_runs for select to authenticated
  using ((select is_admin()));
drop policy if exists "Admins read agent tasks" on public.agent_tasks;
create policy "Admins read agent tasks" on public.agent_tasks for select to authenticated
  using ((select is_admin()));
drop policy if exists "Admins update agent tasks" on public.agent_tasks;
create policy "Admins update agent tasks" on public.agent_tasks for update to authenticated
  using ((select is_admin()))
  with check ((select is_admin()));

grant select on public.agent_heartbeats, public.agent_runs to authenticated;
grant select, update on public.agent_tasks to authenticated;
grant select, insert, update, delete on public.agent_heartbeats, public.agent_runs, public.agent_tasks to service_role;

-- Who gets the 5am digest and worker alerts. Starts with the owner only;
-- more people can be added later.
alter table public.company_settings
  add column if not exists ops_manager_user_ids uuid[] not null default '{}';

update public.company_settings
  set ops_manager_user_ids = array(select id from auth.users where lower(email) = 'jasper@thomsonenergy.com.au')
  where id = 1 and ops_manager_user_ids = '{}';
