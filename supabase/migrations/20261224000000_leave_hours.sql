-- Item 118 (owner, 26 Nov 2026): leave by the hour.
--
--   1  leave_requests.hours: empty = whole days, as before. A number = part of one weekday
--      (more than 0, less than 8). Hours worked plus leave never goes past 8 for the day: that
--      cap is applied on the server when the timesheets are pushed (push-timesheets-to-xero.js).
-- No policy changes: the staff and Admin and Finance policies already cover the new column.

alter table public.leave_requests
  add column if not exists hours numeric;

alter table public.leave_requests drop constraint if exists leave_requests_hours_part_day;
alter table public.leave_requests add constraint leave_requests_hours_part_day
  check (hours is null or (hours > 0 and hours < 8 and start_date = end_date and extract(isodow from start_date) < 6));
