-- A job task can only be ticked once all of its subtasks are ticked (spec A13).
-- Ticking a task used to tick every open subtask with it, which lost which ones
-- were really done. Enforced here so every place that ticks tasks (job page,
-- Tasks, My Day, meetings, Sparky) follows it.

create or replace function public.job_tasks_block_parent_tick()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.completed and not coalesce(old.completed, false)
     and exists (select 1 from public.job_tasks c where c.parent_task_id = new.id and not c.completed) then
    raise exception 'Tick off all of its subtasks first' using errcode = 'P0001';
  end if;
  return new;
end $function$;

drop trigger if exists job_tasks_block_parent_tick on public.job_tasks;
create trigger job_tasks_block_parent_tick before update of completed on public.job_tasks
  for each row execute function public.job_tasks_block_parent_tick();
