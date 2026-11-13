-- Migration 147 - Who's clocked in right now
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Field staff can only read their own time_entries (migration 013), but
-- everyone should be able to see who's on the tools and where: the
-- "Clocked in now" card on Schedule and Team, and the "on this job now"
-- line on a job's Summary. This hands back only the open entries (no
-- clock_out yet) and only what's needed to show them - no history, no
-- pay details. Pass a project id to get just that job's.

create or replace function get_active_clock_ins(p_project_id uuid default null)
returns table (
  entry_id uuid,
  staff_id uuid,
  full_name text,
  project_id uuid,
  project_name text,
  job_number int,
  quote_number int,
  time_category text,
  clock_in timestamptz,
  stage_names text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    te.id,
    te.staff_id,
    pr.full_name,
    te.project_id,
    p.name,
    p.job_number,
    p.quote_number,
    te.time_category,
    te.clock_in,
    (select array_agg(cc.name order by cc.sort_order)
       from cost_centres cc
      where cc.id = te.cost_centre_id or cc.id = any(coalesce(te.selected_cost_centre_ids, '{}'::uuid[])))
  from time_entries te
  left join profiles pr on pr.id = te.staff_id
  left join projects p on p.id = te.project_id
  where te.clock_out is null
    and auth.uid() is not null
    and (p_project_id is null or te.project_id = p_project_id)
  order by pr.full_name;
$$;

revoke all on function get_active_clock_ins(uuid) from public, anon;
grant execute on function get_active_clock_ins(uuid) to authenticated;
