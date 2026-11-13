-- Google Tasks style checklists on the job card: a task can have subtasks
-- (one level), a free-text note, a star, and a manual order.
alter table job_tasks add column if not exists parent_task_id uuid references job_tasks(id) on delete cascade;
alter table job_tasks add column if not exists notes text;
alter table job_tasks add column if not exists starred boolean not null default false;
alter table job_tasks add column if not exists sort_order integer;
create index if not exists job_tasks_parent_idx on job_tasks (parent_task_id) where parent_task_id is not null;
