-- Migration 027 — Non-billable time categories
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Previously "no job selected" just meant unlabeled General/Office time -
-- fine for clocking in, useless for actually knowing where non-billable
-- hours go. Both the schedule (planned) and time_entries (actual) now
-- carry a real category, so training/office time can be summed and
-- costed the same way job time already is - just against no specific
-- job/stage.

alter table time_entries add column if not exists time_category text not null default 'job';
alter table time_entries drop constraint if exists time_entries_category_check;
alter table time_entries add constraint time_entries_category_check
  check (time_category in ('job', 'training', 'office', 'other'));

alter table schedule_assignments add column if not exists block_type text not null default 'job';
alter table schedule_assignments drop constraint if exists schedule_assignments_block_type_check;
alter table schedule_assignments add constraint schedule_assignments_block_type_check
  check (block_type in ('job', 'training', 'office', 'other'));
alter table schedule_assignments add column if not exists note text;

-- Real cost of non-billable time by category, for a date range - this is
-- what answers "how much did training actually cost us this month."
create or replace function get_nonbillable_cost_by_category(p_start date, p_end date)
returns table(category text, total_hours numeric, total_cost numeric)
language plpgsql
security definer
as $$
begin
  return query
  select
    te.time_category,
    coalesce(sum(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0), 0) as total_hours,
    coalesce(sum(
      (extract(epoch from (te.clock_out - te.clock_in)) / 3600.0) *
      case classify_timesheet_rate_category(te.clock_in)
        when '2.5x' then coalesce(p.rate_2_5x, p.ordinary_rate, 0)
        when '2x' then coalesce(p.rate_2x, p.ordinary_rate, 0)
        when '1.5x' then coalesce(p.rate_1_5x, p.ordinary_rate, 0)
        else coalesce(p.ordinary_rate, 0)
      end
    ), 0) as total_cost
  from time_entries te
  join profiles p on p.id = te.staff_id
  where te.time_category != 'job'
    and te.clock_out is not null
    and (te.clock_in AT TIME ZONE 'Australia/Sydney')::date between p_start and p_end
  group by te.time_category;
end;
$$;
