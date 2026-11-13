-- Migration 074 — Recurring tasks
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- A task can be marked to repeat daily/weekly/monthly. The next occurrence
-- is spawned by a trigger the moment a task is completed, so it doesn't
-- matter which of the three places a task gets marked done (tasks.html,
-- my-day.html, project.html) - one place to get this right instead of
-- three copies of the same logic.

alter table job_tasks add column if not exists recurrence text
  check (recurrence in ('daily', 'weekly', 'monthly'));

create or replace function job_tasks_spawn_next_occurrence()
returns trigger as $$
declare
  next_due date;
begin
  if new.completed = true and coalesce(old.completed, false) = false
     and new.recurrence is not null and new.due_date is not null then
    next_due := case new.recurrence
      when 'daily' then new.due_date + interval '1 day'
      when 'weekly' then new.due_date + interval '7 days'
      when 'monthly' then new.due_date + interval '1 month'
    end;
    insert into job_tasks (
      project_id, description, assigned_to_user_id, assigned_to_role,
      required_before_scheduling, task_type, due_date, recurrence, created_by
    ) values (
      new.project_id, new.description, new.assigned_to_user_id, new.assigned_to_role,
      new.required_before_scheduling, new.task_type, next_due, new.recurrence, new.created_by
    );
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_job_tasks_spawn_next on job_tasks;
create trigger trg_job_tasks_spawn_next
  after update on job_tasks
  for each row
  execute function job_tasks_spawn_next_occurrence();
