-- Only needed if you already ran schema.sql before this update. Safe to run
-- even if you haven't, it will just do nothing.
--
-- job_tasks backs the "Tasks" card on the project Summary tab (per-project
-- checklist items, optionally assigned to a person or a role, optionally
-- required before the job can be scheduled).

create table if not exists job_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  assigned_to_user_id uuid references profiles(id) on delete set null,
  assigned_to_role text,
  required_before_scheduling boolean not null default false,
  completed boolean not null default false,
  completed_by uuid references profiles(id) on delete set null,
  completed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists job_tasks_project_id_idx on job_tasks (project_id);

alter table job_tasks enable row level security;
drop policy if exists "staff full access on job_tasks" on job_tasks;
create policy "staff full access on job_tasks"
  on job_tasks for all to authenticated using (true) with check (true);
