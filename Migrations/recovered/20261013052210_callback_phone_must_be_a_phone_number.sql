-- Recovered 17 Oct 2026 from the live migration history (applied 13 Oct 2026,
-- never saved to the repo). Historical record only: the baseline in
-- supabase/migrations already contains this.
create or replace function public.book_callback_slot(p_date date, p_time time without time zone, p_name text, p_phone text, p_email text, p_message text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  -- a phone number is digits plus the usual + ( ) - and spaces, 8 digits or more
  -- (a name typed into the phone box used to be accepted and saved as the number)
  if trim(p_phone) !~ '^[0-9+()\s-]{8,20}$' or length(regexp_replace(p_phone, '\D', '', 'g')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'That doesn''t look like a phone number, please check it.');
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
$function$;
