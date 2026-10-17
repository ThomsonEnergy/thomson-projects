-- Recovered 17 Oct 2026 from the live migration history (applied 13 Oct 2026,
-- never saved to the repo). Historical record only: the baseline in
-- supabase/migrations already contains this.
drop function if exists overhead_hours_basis();
create or replace function overhead_hours_basis(p_mode text default null)
returns table (paid_hours numeric, billable_hours numeric, mode text)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_mode text;
  v_first timestamptz;
  v_scale numeric := 1;
  v_paid numeric; v_bill numeric;
begin
  if not is_finance_role() then return; end if;
  select * into s from overhead_settings where id = 1;
  v_mode := coalesce(p_mode, s.hours_mode);
  if v_mode = 'timesheets' then
    select min(clock_in) into v_first from time_entries where clock_out is not null and clock_in >= now() - interval '12 months';
    if v_first is not null then
      v_scale := 365.0 / greatest(30, extract(epoch from (now() - v_first)) / 86400.0);
      if v_scale < 1 then v_scale := 1; end if;
    end if;
    select coalesce(sum(extract(epoch from (clock_out - clock_in)) / 3600.0 - coalesce(break_minutes, 0) / 60.0), 0),
           coalesce(sum(case when time_category = 'job' then extract(epoch from (clock_out - clock_in)) / 3600.0 - coalesce(break_minutes, 0) / 60.0 else 0 end), 0)
      into v_paid, v_bill
      from time_entries where clock_out is not null and clock_in >= now() - interval '12 months';
    return query select round(v_paid * v_scale, 2), round(v_bill * v_scale, 2), 'timesheets'::text;
  else
    return query select s.paid_hours_per_year, s.billable_hours_per_year, 'manual'::text;
  end if;
end $$;
revoke all on function overhead_hours_basis(text) from public, anon;
grant execute on function overhead_hours_basis(text) to authenticated;
