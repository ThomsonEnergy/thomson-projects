-- Timesheet entries with no job attached were being saved with the column's
-- default category 'job' (manual/older entry paths, e.g. a whole admin day),
-- so they never showed in the Non-billable time totals or Xero's non-billable
-- tracking. "Job" time with no job isn't job time: it's office time. This
-- fixes existing rows and stops it recurring from any code path.
create or replace function time_entries_no_job_means_office() returns trigger
language plpgsql as $$
begin
  if new.project_id is null and new.time_category = 'job' then
    new.time_category := 'office';
  end if;
  return new;
end;
$$;

drop trigger if exists time_entries_category_fix on time_entries;
create trigger time_entries_category_fix
  before insert or update of project_id, time_category on time_entries
  for each row execute function time_entries_no_job_means_office();

update time_entries set time_category = 'office' where project_id is null and time_category = 'job';
