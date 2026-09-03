-- Migration 073 — Split existing timesheet entries that cross local midnight
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Before this fix, clocking out after midnight (Australia/Sydney time)
-- left a single time_entries row spanning two calendar days. Both the
-- timesheet week view and the server-side labour-cost banding key
-- everything off a row's Sydney LOCAL date, so those hours were entirely
-- misattributed to whichever day the shift started on. my-day.html now
-- splits at clock-out time so this can't happen going forward - this is
-- the one-time fix for whatever's already in the table.

do $$
declare
  r record;
  seg_start timestamptz;
  seg_end timestamptz;
  day_end timestamptz;
begin
  for r in
    select * from time_entries
    where clock_out is not null
      and (clock_out at time zone 'Australia/Sydney')::date > (clock_in at time zone 'Australia/Sydney')::date
  loop
    day_end := (((r.clock_in at time zone 'Australia/Sydney')::date + 1)::timestamp at time zone 'Australia/Sydney');
    update time_entries set clock_out = day_end where id = r.id;

    seg_start := day_end;
    while seg_start < r.clock_out loop
      day_end := (((seg_start at time zone 'Australia/Sydney')::date + 1)::timestamp at time zone 'Australia/Sydney');
      seg_end := least(day_end, r.clock_out);
      insert into time_entries (staff_id, project_id, cost_centre_id, selected_cost_centre_ids, time_category, clock_in, clock_out)
      values (r.staff_id, r.project_id, r.cost_centre_id, r.selected_cost_centre_ids, r.time_category, seg_start, seg_end);
      seg_start := seg_end;
    end loop;
  end loop;
end $$;
