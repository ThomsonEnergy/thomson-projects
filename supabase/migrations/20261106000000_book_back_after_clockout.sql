-- "Not complete, back <day>" at clock-out books the tradie back on the job.
-- Staff-role users cannot write schedule_assignments (pricing roles only), so the
-- direct insert from the browser failed for them. This function lets any active
-- user book themselves back, but only on a job they clocked out of in the last
-- 18 hours, only for the next 7 days, and never twice on the same job and day.

create or replace function public.book_back_after_clockout(p_project_id uuid, p_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from profiles where id = v_uid and active) then
    raise exception 'Only active staff can book back in';
  end if;
  if p_project_id is null or p_date is null then raise exception 'Missing job or date'; end if;
  if p_date <= sydney_today() or p_date > sydney_today() + 7 then
    raise exception 'Back-in date must be within the next 7 days';
  end if;
  if not exists (
    select 1 from time_entries
    where staff_id = v_uid and project_id = p_project_id
      and clock_out is not null and clock_out > now() - interval '18 hours'
  ) then
    raise exception 'You can only book back on a job you just clocked out of';
  end if;
  if exists (
    select 1 from schedule_assignments
    where staff_id = v_uid and project_id = p_project_id and assignment_date = p_date
  ) then
    return 'already';
  end if;
  insert into schedule_assignments (staff_id, project_id, block_type, assignment_date, start_time, end_time)
  values (v_uid, p_project_id, 'job', p_date, '07:00', '15:00');
  return 'booked';
end $$;

revoke execute on function public.book_back_after_clockout(uuid, date) from public, anon;
grant execute on function public.book_back_after_clockout(uuid, date) to authenticated;
