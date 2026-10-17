-- Recovered 17 Oct 2026 from the live migration history (applied 19 Sep 2026,
-- never saved to the repo). Historical record only: the baseline in
-- supabase/migrations already contains this. book_callback_slot was later
-- replaced by 20261013052210_callback_phone_must_be_a_phone_number.sql.

-- Returns each bookable weekday half-hour slot in the given range that
-- still has room, so the website can grey out full slots without ever
-- needing read access to the callback_requests table directly.
create or replace function public.get_available_callback_slots(p_start_date date, p_end_date date)
returns table(slot_date date, slot_time time, spots_left int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot_minutes int := 30;
  v_max_per_slot int := 2;
  v_open time := '08:00';
  v_close time := '17:00';
  v_day date;
  v_time time;
  v_booked int;
begin
  if p_end_date < p_start_date or p_end_date - p_start_date > 30 then
    raise exception 'Invalid date range';
  end if;

  v_day := p_start_date;
  while v_day <= p_end_date loop
    if extract(isodow from v_day) between 1 and 5 then
      v_time := v_open;
      while v_time < v_close loop
        select count(*) into v_booked
        from public.callback_requests
        where requested_date = v_day
          and requested_time = v_time
          and status <> 'cancelled';

        if v_max_per_slot - v_booked > 0 then
          slot_date := v_day;
          slot_time := v_time;
          spots_left := v_max_per_slot - v_booked;
          return next;
        end if;

        v_time := v_time + (v_slot_minutes || ' minutes')::interval;
      end loop;
    end if;
    v_day := v_day + 1;
  end loop;
end;
$$;

grant execute on function public.get_available_callback_slots(date, date) to anon;

-- Atomically checks capacity and books a slot, so two visitors can't
-- both land the same slot. Runs as SECURITY DEFINER since anon has no
-- direct access to callback_requests at all, only through here.
create or replace function public.book_callback_slot(
  p_date date, p_time time, p_name text, p_phone text, p_email text, p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_per_slot int := 2;
  v_open time := '08:00';
  v_close time := '17:00';
  v_booked int;
  v_id uuid;
begin
  if extract(isodow from p_date) not between 1 and 5 then
    return jsonb_build_object('ok', false, 'error', 'Weekends aren''t bookable, please pick a weekday.');
  end if;
  if p_date < current_date then
    return jsonb_build_object('ok', false, 'error', 'That date has passed, please pick another.');
  end if;
  if p_time < v_open or p_time >= v_close then
    return jsonb_build_object('ok', false, 'error', 'Outside business hours (8am-5pm).');
  end if;
  if coalesce(trim(p_phone), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'A phone number is required.');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_date::text || p_time::text));

  select count(*) into v_booked
  from public.callback_requests
  where requested_date = p_date
    and requested_time = p_time
    and status <> 'cancelled';

  if v_booked >= v_max_per_slot then
    return jsonb_build_object('ok', false, 'error', 'That slot just filled up, please pick another.');
  end if;

  insert into public.callback_requests (name, phone, email, requested_date, requested_time, message)
  values (nullif(trim(p_name), ''), trim(p_phone), nullif(trim(p_email), ''), p_date, p_time, nullif(trim(p_message), ''))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

grant execute on function public.book_callback_slot(date, time, text, text, text, text) to anon;
