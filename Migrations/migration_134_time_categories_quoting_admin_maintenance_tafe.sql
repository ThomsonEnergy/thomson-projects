-- Non-job timesheet categories: Quoting, Admin, Maintenance, TAFE, Training
-- (replacing the old Office / Training / Other trio). Each syncs to Xero as
-- its own tracking option (push-timesheets-to-xero.js), same mechanism the
-- three fixed options used before.
--
-- 'office' and 'other' stay allowed so nothing already saved, or any page
-- still running older cached JS, breaks - but existing 'office' time is
-- relabelled 'admin' (same thing: "Office / admin"), and TAFE days that were
-- being saved as 'training' with a TAFE note become real 'tafe' entries.

alter table time_entries drop constraint if exists time_entries_category_check;
alter table time_entries add constraint time_entries_category_check
  check (time_category in ('job', 'quoting', 'admin', 'maintenance', 'tafe', 'training', 'office', 'other'));

alter table schedule_assignments drop constraint if exists schedule_assignments_block_type_check;
alter table schedule_assignments add constraint schedule_assignments_block_type_check
  check (block_type in ('job', 'site_visit', 'site_inspection', 'quoting', 'admin', 'maintenance', 'tafe', 'training', 'office', 'other'));

-- A job-less entry saved as 'job' used to be corrected to 'office' (migration
-- 120); it's 'admin' now.
create or replace function time_entries_no_job_means_office() returns trigger
language plpgsql as $$
begin
  if new.project_id is null and new.time_category = 'job' then
    new.time_category := 'admin';
  end if;
  return new;
end;
$$;

update time_entries set time_category = 'tafe' where time_category = 'training' and notes ilike 'tafe%';
update time_entries set time_category = 'admin' where time_category = 'office';
update schedule_assignments set block_type = 'admin' where block_type = 'office';
