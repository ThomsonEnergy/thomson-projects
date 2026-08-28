-- Migration 043 — Job tasks
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Tasks created at quote stage (or any time after) carry straight
-- through to the job automatically, since a quote and its eventual job
-- are the same underlying project record - no separate handoff needed.
-- A task can be assigned to a specific person, a role, or left
-- unassigned for anyone free to pick up.

create table if not exists job_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  assigned_to_user_id uuid references profiles(id),
  assigned_to_role text check (assigned_to_role in ('admin', 'finance', 'sales', 'staff')),
  required_before_scheduling boolean not null default false,
  completed boolean not null default false,
  completed_by uuid references profiles(id),
  completed_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table job_tasks enable row level security;
drop policy if exists "Everyone can view job tasks" on job_tasks;
create policy "Everyone can view job tasks" on job_tasks for select using (true);
drop policy if exists "Everyone can manage job tasks" on job_tasks;
create policy "Everyone can manage job tasks" on job_tasks
  for all using (auth.uid() is not null) with check (auth.uid() is not null);
