-- Item 85 (13 Nov 2026): Jobs list columns you choose, and one rule for costs to date.
-- Additions only: one column, one read function. Nothing is changed or removed.

-- 1. profiles.ui_prefs: a person's own screen choices, saved with their profile so the laptop
--    and the phone match. First use: the Jobs list's columns and their order
--    ({"jobs_columns": ["name", "client", ...]}). A person updates only their own row (the
--    existing profiles policies and guard_profiles_writes); nothing in it decides access.
alter table public.profiles add column if not exists ui_prefs jsonb not null default '{}'::jsonb;
-- profiles has no table-wide SELECT for authenticated (baseline section 10): each readable column is granted.
grant select (ui_prefs) on public.profiles to authenticated;

-- 2. jobs_list_facts(job ids): what the Jobs list shows per job that is not on the job's own row,
--    for every job on the list in one call (public/js/jobs-columns.js):
--      last_on_site        the last Sydney day anyone was clocked in on the job (today while someone is)
--      next_booked         the next Schedule day for the job, today onwards, and who is booked that day
--      materials_cost      materials costed to the job so far: every job_material_usage row, which is
--                          each PO line received to the job (whichever PO it is on, written the moment it
--                          is ticked received) and each item taken from the warehouse or a van (written
--                          the moment it is used), at cost. The job page adds up the same rows.
--                          Pricing roles only; null for anyone else.
--      open_tasks          tasks not ticked off (a task's own steps are not counted twice)
--      open_pos            purchase orders raised for the job and not closed
--    Read only. Security definer because it reads across time entries, bookings and stock usage in
--    one go; it answers only for an active staff login and returns dates, names and counts (plus the
--    materials figure for pricing roles).
create or replace function public.jobs_list_facts(p_project_ids uuid[])
returns table (
  project_id uuid,
  last_on_site date,
  next_booked date,
  next_booked_staff text,
  materials_cost numeric,
  open_tasks integer,
  open_pos integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    (select max((te.clock_in at time zone 'Australia/Sydney')::date)
       from time_entries te
      where te.project_id = p.id and te.clock_in <= now()),
    nb.day,
    (select string_agg(x.full_name, ', ' order by x.full_name)
       from (select distinct pr.full_name
               from schedule_assignments sa
               join profiles pr on pr.id = sa.staff_id
              where sa.project_id = p.id and sa.assignment_date = nb.day) x),
    case when (select is_pricing_role())
         then coalesce((select sum(u.quantity * u.unit_cost) from job_material_usage u where u.project_id = p.id), 0)
    end,
    (select count(*)::integer from job_tasks t where t.project_id = p.id and not t.completed and t.parent_task_id is null),
    (select count(*)::integer from purchase_orders po where po.project_id = p.id and po.closed_at is null)
  from projects p
  left join lateral (
    select min(sa.assignment_date) as day
      from schedule_assignments sa
     where sa.project_id = p.id and sa.assignment_date >= sydney_today()
  ) nb on true
  where p.id = any (p_project_ids)
    and exists (select 1 from profiles me where me.id = (select auth.uid()) and me.active);
$$;

revoke execute on function public.jobs_list_facts(uuid[]) from public, anon;
grant execute on function public.jobs_list_facts(uuid[]) to authenticated;
