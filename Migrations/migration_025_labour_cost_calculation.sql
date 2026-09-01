-- Migration 025 — Timesheet cost classification and labour cost rollup
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Classifies a logged shift into ordinary/1.5x/2x/2.5x based on when it
-- was actually worked (Thomson Energy standard hours: Mon-Fri 6:30am-4pm,
-- per the Schedule of Rates), then looks up that employee's own rate for
-- that category to compute real cost - not a generic multiplier of one
-- base rate, since award rates don't cleanly multiply.
--
-- A whole shift is classified by its start time, not split hour-by-hour
-- across a boundary - a reasonable simplification for how shifts are
-- actually logged in practice, worth knowing if a shift genuinely spans
-- from ordinary hours into after-hours.

create or replace function classify_timesheet_rate_category(p_clock_in timestamptz)
returns text
language plpgsql
as $$
declare
  local_ts timestamp; -- AT TIME ZONE on a timestamptz returns plain timestamp
                       -- (naive local wall-clock) - declaring this as
                       -- timestamptz would silently cast it back using the
                       -- session timezone, reintroducing the exact bug
                       -- this conversion exists to avoid.
  local_date date;
  local_time time;
  dow int;
begin
  local_ts := p_clock_in AT TIME ZONE 'Australia/Sydney';
  local_date := local_ts::date;
  local_time := local_ts::time;
  dow := extract(isodow from local_date); -- Monday=1 ... Sunday=7

  if exists (select 1 from public_holidays where holiday_date = local_date) then
    return '2.5x';
  end if;

  if dow = 7 then -- Sunday
    return '2x';
  end if;

  if dow = 6 then -- Saturday
    return '1.5x';
  end if;

  -- Weekday, outside 6:30am-4:00pm
  if local_time < time '06:30:00' or local_time >= time '16:00:00' then
    return '1.5x';
  end if;

  return 'ordinary';
end;
$$;

-- Real labour cost for a single stage, from actual logged time - each
-- shift costed at the employee's own rate for whatever category it falls
-- into, plus their allowances apportioned by the share of that day's
-- total hours that went to this particular stage (so someone splitting a
-- day across two jobs doesn't get their daily allowance double-counted
-- on both).
create or replace function get_stage_actual_labour_cost(p_cost_centre_id uuid)
returns numeric
language plpgsql
security definer
as $$
declare
  shift_cost numeric := 0;
  allowance_cost numeric := 0;
begin
  select coalesce(sum(
    (extract(epoch from (te.clock_out - te.clock_in)) / 3600.0) *
    case classify_timesheet_rate_category(te.clock_in)
      when '2.5x' then coalesce(p.rate_2_5x, p.ordinary_rate, 0)
      when '2x' then coalesce(p.rate_2x, p.ordinary_rate, 0)
      when '1.5x' then coalesce(p.rate_1_5x, p.ordinary_rate, 0)
      else coalesce(p.ordinary_rate, 0)
    end
  ), 0)
  into shift_cost
  from time_entries te
  join profiles p on p.id = te.staff_id
  where te.cost_centre_id = p_cost_centre_id
    and te.clock_out is not null;

  -- Allowances: for each employee-day that touched this stage, apportion
  -- their per-day allowances by (hours on this stage / hours that day
  -- across all stages). Per-hour allowances just apply to the hours
  -- actually logged on this stage directly - no apportionment needed.
  select coalesce(sum(
    case ea.frequency
      when 'per_day' then ea.amount * (stage_hours.hrs / day_hours.total_hrs)
      when 'per_hour' then ea.amount * stage_hours.hrs
      else 0
    end
  ), 0)
  into allowance_cost
  from (
    select te.staff_id, (te.clock_in AT TIME ZONE 'Australia/Sydney')::date as work_date,
      sum(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0) as hrs
    from time_entries te
    where te.cost_centre_id = p_cost_centre_id and te.clock_out is not null
    group by te.staff_id, (te.clock_in AT TIME ZONE 'Australia/Sydney')::date
  ) stage_hours
  join (
    select te.staff_id, (te.clock_in AT TIME ZONE 'Australia/Sydney')::date as work_date,
      sum(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0) as total_hrs
    from time_entries te
    where te.clock_out is not null
    group by te.staff_id, (te.clock_in AT TIME ZONE 'Australia/Sydney')::date
  ) day_hours on day_hours.staff_id = stage_hours.staff_id and day_hours.work_date = stage_hours.work_date
  join employee_allowances ea on ea.profile_id = stage_hours.staff_id
  where day_hours.total_hrs > 0;

  return shift_cost + allowance_cost;
end;
$$;

-- Total hours logged against a stage, for the hours-based display that
-- Staff/Sales see (they see hours, never dollars).
create or replace function get_stage_actual_hours(p_cost_centre_id uuid)
returns numeric
language sql
security definer
as $$
  select coalesce(sum(extract(epoch from (clock_out - clock_in)) / 3600.0), 0)
  from time_entries
  where cost_centre_id = p_cost_centre_id and clock_out is not null;
$$;
