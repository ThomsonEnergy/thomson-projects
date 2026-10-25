-- One open clock-in per person (bug F10): a double tap on Clock in made two open
-- time_entries rows. My Day now blocks it in the app; this is the safety net.
-- Every app flow closes the old entry before opening a new one (switch job clocks out
-- first, then inserts; midnight and stage splits insert closed rows only).
--
-- Stops with a clear message if anyone already has two open entries, rather than
-- guessing which one to close. Find them with:
--   select staff_id, array_agg(id order by clock_in) as ids, array_agg(clock_in order by clock_in) as clock_ins
--   from public.time_entries where clock_out is null group by staff_id having count(*) > 1;
-- Close the stale one(s) on Timesheets, then run this again.

do $$
declare
  v_people integer;
begin
  select count(*) into v_people from (
    select staff_id from public.time_entries where clock_out is null group by staff_id having count(*) > 1
  ) d;
  if v_people > 0 then
    raise exception '% person(s) have more than one open clock-in. Close the extra ones first (query in the header of this migration).', v_people;
  end if;
end;
$$;

create unique index if not exists time_entries_one_open_per_staff
  on public.time_entries (staff_id)
  where clock_out is null;
