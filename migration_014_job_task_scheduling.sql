-- Adds a due date to job_tasks, plus an optional link to a real Schedule
-- calendar entry - "Add task" can now either just set a due date, or
-- actually place the task on the assigned person's Schedule for that day
-- (a real schedule_assignments row), or both.
--
-- Run migration_009_job_tasks.sql first if you haven't already - this
-- just adds two columns to the table it creates.

alter table job_tasks add column if not exists due_date date;
alter table job_tasks add column if not exists schedule_assignment_id uuid references schedule_assignments(id) on delete set null;
