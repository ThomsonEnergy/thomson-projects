-- Overheads v2 (applied to the live database as "overheads_v2_people_and_monthly").
-- Replaces the hours model from migration 141: company overhead is a PERCENTAGE of each job's profit,
-- hours are per person (default 1600 a year, editable, part-time and admin-only staff can differ),
-- and non-billable wages are calculated from timesheets and admin pay instead of typed in.
-- Everything stays finance-only (admin and finance roles).

alter table overhead_settings drop column if exists paid_hours_per_year;
alter table overhead_settings drop column if exists billable_hours_per_year;
alter table overhead_settings add column if not exists company_basis text not null default 'profit' check (company_basis in ('profit', 'revenue'));
alter table overhead_settings add column if not exists expected_annual_base numeric(14, 2) not null default 0;
alter table overhead_settings add column if not exists default_hours_per_person numeric(8, 2) not null default 1600;

create table if not exists overhead_people (
  profile_id uuid primary key references profiles(id) on delete cascade,
  hours_per_year numeric(8, 2),
  billable boolean,
  note text,
  updated_at timestamptz not null default now()
);
alter table overhead_people enable row level security;
drop policy if exists "finance full access on overhead_people" on overhead_people;
create policy "finance full access on overhead_people" on overhead_people for all to authenticated using (is_finance_role()) with check (is_finance_role());

drop function if exists get_overhead_rates();
drop function if exists overhead_hours_basis(text);

-- INTERNAL (no caller check, not granted to anyone): one row per active person with the hours they are counted for.
create or replace function overhead_people_basis(p_mode text default null)
returns table (profile_id uuid, full_name text, role text, billable boolean, paid_hours numeric, job_hours numeric, nonjob_hours numeric, hourly_cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_mode text;
  v_scale numeric := 1;
  v_first timestamptz;
begin
  select * into s from overhead_settings where id = 1;
  v_mode := coalesce(p_mode, s.hours_mode);
  select min(t.clock_in) into v_first from time_entries t where t.clock_out is not null and t.clock_in >= now() - interval '12 months';
  if v_first is not null then
    v_scale := greatest(1, 365.0 / greatest(30, extract(epoch from (now() - v_first)) / 86400.0));
  end if;
  return query
  with hrs as (
    select te.staff_id,
      sum(case when te.time_category = 'job' then te.h else 0 end) as job_h,
      sum(case when te.time_category = 'job' then 0 else te.h end) as nonjob_h
    from (select t.staff_id, t.time_category, extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0 as h
          from time_entries t where t.clock_out is not null and t.clock_in >= now() - interval '12 months') te
    group by te.staff_id)
  select p.id, p.full_name, p.role,
    coalesce(op.billable, p.role in ('staff', 'sales')),
    case when v_mode = 'timesheets' and coalesce(h.job_h, 0) + coalesce(h.nonjob_h, 0) > 0
         then round((h.job_h + h.nonjob_h) * v_scale, 2)
         else coalesce(op.hours_per_year, s.default_hours_per_person) end,
    round(coalesce(h.job_h, 0) * v_scale, 2),
    round(coalesce(h.nonjob_h, 0) * v_scale, 2),
    coalesce(p.ordinary_rate, 0)
  from profiles p
  left join overhead_people op on op.profile_id = p.id
  left join hrs h on h.staff_id = p.id
  where p.active;
end $$;
revoke all on function overhead_people_basis(text) from public, anon, authenticated;

-- INTERNAL: the rates. Also used by the nightly job (no user, so no caller check here).
create or replace function compute_overhead_rates()
returns table (employee_rate numeric, company_pct numeric, company_basis text, employee_total numeric, company_total numeric, nonbillable_wages numeric, nonbillable_people_wages numeric, staff_hours numeric, mode text)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_emp numeric; v_co numeric; v_hours numeric; v_nbw numeric; v_nbw_people numeric;
begin
  select * into s from overhead_settings where id = 1;
  select coalesce(sum(l.annual_amount) filter (where l.bucket = 'employee'), 0), coalesce(sum(l.annual_amount) filter (where l.bucket = 'company'), 0)
    into v_emp, v_co from overhead_lines l;
  select coalesce(sum(b.paid_hours) filter (where b.billable), 0) into v_hours from overhead_people_basis() b;
  -- non-billable wages, per year: everyone's non-job time at their own rate, plus the whole year of anyone flagged
  -- as not billable (office / admin staff), on their salary if they have one, otherwise rate x hours
  select coalesce(sum(case when b.billable then b.nonjob_hours * b.hourly_cost else 0 end), 0) +
         coalesce(sum(case when not b.billable then coalesce(nullif((select pr.annual_salary from profiles pr where pr.id = b.profile_id), 0), b.paid_hours * b.hourly_cost) else 0 end), 0),
         coalesce(sum(case when not b.billable then coalesce(nullif((select pr.annual_salary from profiles pr where pr.id = b.profile_id), 0), b.paid_hours * b.hourly_cost) else 0 end), 0)
    into v_nbw, v_nbw_people from overhead_people_basis() b;
  return query select
    case when v_hours > 0 then round(v_emp / v_hours, 2) else 0::numeric end,
    case when s.expected_annual_base > 0 then round((v_co + v_nbw) / s.expected_annual_base * 100, 2) else 0::numeric end,
    s.company_basis, v_emp, v_co + v_nbw, round(v_nbw, 2), round(v_nbw_people, 2), v_hours, s.hours_mode;
end $$;
revoke all on function compute_overhead_rates() from public, anon, authenticated;

-- What the pages call (Finance and Admin only: anyone else gets no rows).
create or replace function get_overhead_rates()
returns table (employee_rate numeric, company_pct numeric, company_basis text, employee_total numeric, company_total numeric, nonbillable_wages numeric, nonbillable_people_wages numeric, staff_hours numeric, mode text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_finance_role() then return; end if;
  return query select * from compute_overhead_rates();
end $$;
revoke all on function get_overhead_rates() from public, anon;
grant execute on function get_overhead_rates() to authenticated;

create or replace function get_overhead_people(p_mode text default null)
returns table (profile_id uuid, full_name text, role text, billable boolean, paid_hours numeric, job_hours numeric, nonjob_hours numeric, hourly_cost numeric, custom_hours boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_finance_role() then return; end if;
  return query select b.profile_id, b.full_name, b.role, b.billable, b.paid_hours, b.job_hours, b.nonjob_hours, b.hourly_cost,
    exists (select 1 from overhead_people op where op.profile_id = b.profile_id and op.hours_per_year is not null)
  from overhead_people_basis(p_mode) b order by b.full_name;
end $$;
revoke all on function get_overhead_people(text) from public, anon;
grant execute on function get_overhead_people(text) to authenticated;

-- Company-level month by month: what came in against everything it cost (estimated from invoices, received
-- materials, timesheets and the yearly overhead lines divided by 12).
create or replace function get_monthly_net_summary(p_months int default 12)
returns table (month date, revenue numeric, materials numeric, job_labour numeric, gross_profit numeric, nonbillable_wages numeric, employee_costs numeric, company_costs numeric, net_profit numeric, job_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_emp numeric; v_co numeric; v_nbw_people numeric;
begin
  if not is_finance_role() then return; end if;
  select cr.employee_total, cr.company_total - cr.nonbillable_wages, cr.nonbillable_people_wages
    into v_emp, v_co, v_nbw_people from compute_overhead_rates() cr;
  return query
  with months as (
    select generate_series(date_trunc('month', now() at time zone 'Australia/Sydney')::date - ((greatest(1, least(p_months, 24)) - 1) || ' months')::interval,
                           date_trunc('month', now() at time zone 'Australia/Sydney')::date, interval '1 month')::date as m),
  rev as (
    select date_trunc('month', i.sent_at at time zone 'Australia/Sydney')::date as m, sum(coalesce(i.labour_amount, 0) + coalesce(i.material_amount, 0)) as v
    from invoices i where i.sent_at is not null group by 1),
  mat as (
    select date_trunc('month', li.received_at at time zone 'Australia/Sydney')::date as m, sum(li.quantity * li.unit_cost) as v
    from purchase_order_line_items li where li.received and li.received_at is not null group by 1),
  tm as (
    select date_trunc('month', t.clock_in at time zone 'Australia/Sydney')::date as m,
      sum(case when t.time_category = 'job' then h.hrs else 0 end) as job_hours,
      sum(case when t.time_category = 'job' then h.hrs * coalesce(p.ordinary_rate, 0) else 0 end) as job_wages,
      sum(case when t.time_category <> 'job' and coalesce(op.billable, p.role in ('staff', 'sales')) then h.hrs * coalesce(p.ordinary_rate, 0) else 0 end) as nonjob_wages
    from time_entries t
    join profiles p on p.id = t.staff_id
    left join overhead_people op on op.profile_id = p.id
    cross join lateral (select extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0 as hrs) h
    where t.clock_out is not null group by 1)
  select mo.m,
    round(coalesce(rev.v, 0), 2), round(coalesce(mat.v, 0), 2), round(coalesce(tm.job_wages, 0), 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0), 2),
    round(coalesce(tm.nonjob_wages, 0) + v_nbw_people / 12.0, 2),
    round(v_emp / 12.0, 2), round(v_co / 12.0, 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0) - coalesce(tm.nonjob_wages, 0) - v_nbw_people / 12.0 - v_emp / 12.0 - v_co / 12.0, 2),
    round(coalesce(tm.job_hours, 0), 2)
  from months mo left join rev on rev.m = mo.m left join mat on mat.m = mo.m left join tm on tm.m = mo.m
  order by mo.m desc;
end $$;
revoke all on function get_monthly_net_summary(int) from public, anon;
grant execute on function get_monthly_net_summary(int) to authenticated;

-- Not real staff: left out of the overheads.
insert into overhead_people (profile_id, hours_per_year, billable, note)
select id, 0, false, 'Not a real staff member: left out of overheads' from profiles where full_name in ('Claude', 'Test account')
on conflict (profile_id) do update set hours_per_year = 0, billable = false, note = excluded.note;
