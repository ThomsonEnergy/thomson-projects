-- Overheads v3 (applied to the live database as "overheads_v3_direct_indirect").
-- Reworked along the lines of the simPRO overhead and employment cost calculator, with three overheads:
--   DIRECT employee overhead (per person): their on-costs (super, workers comp and payroll tax as
--     percentages of their wages, annual leave loading, any other employee costs in the 'employee'
--     overhead lines shared by each person's share of wages, plus their own other costs), paid leave,
--     public holidays and training. Divided by THEIR billable hours and added to their hourly cost, so
--     each job carries the real cost of whoever worked on it. Subcontractors get none of these.
--   INDIRECT employee overhead (shared): every non-billable wage hour. Office and admin staff in full
--     (wages plus their on-costs), plus billable people's non-job admin time. Divided by the billable
--     hours of everyone who bills and added to every billable hour.
--   COMPANY costs: non-wage costs only (insurance, vehicles, rent, software...), shared across jobs as
--     a percentage of each job's profit (or price), as before.
-- Billable hours = paid hours less leave, public holidays, training and non-billable time. Per person
-- inputs (days a week, hours a day, leave days, average non-billable hours a day) fall back to the
-- defaults in overhead_settings. In 'timesheets' mode, anyone with 40+ logged hours in the last 12
-- months has their admin and training share of time taken from their real timesheets instead.
-- Everything stays finance-only (admin and finance roles).

drop function if exists get_monthly_net_summary(int);
drop function if exists get_overhead_people(text);
drop function if exists get_overhead_rates();
drop function if exists compute_overhead_rates();
drop function if exists overhead_people_basis(text);

alter table overhead_settings add column if not exists default_days_per_week numeric(4, 2) not null default 5;
alter table overhead_settings add column if not exists default_hours_per_day numeric(5, 2) not null default 8;
alter table overhead_settings add column if not exists default_nonbillable_hours_per_day numeric(5, 2) not null default 1;
alter table overhead_settings add column if not exists public_holidays_per_year numeric(5, 2) not null default 10;
alter table overhead_settings add column if not exists default_annual_leave_days numeric(5, 2) not null default 20;
alter table overhead_settings add column if not exists default_sick_days numeric(5, 2) not null default 10;
alter table overhead_settings add column if not exists default_training_days numeric(5, 2) not null default 0;
alter table overhead_settings add column if not exists super_pct numeric(5, 2) not null default 12;
alter table overhead_settings add column if not exists workers_comp_pct numeric(5, 2) not null default 3;
alter table overhead_settings add column if not exists payroll_tax_pct numeric(5, 2) not null default 0;
alter table overhead_settings add column if not exists leave_loading_pct numeric(5, 2) not null default 17.5;
alter table overhead_settings drop column if exists default_hours_per_person;

alter table overhead_people add column if not exists subcontractor boolean not null default false;
alter table overhead_people add column if not exists days_per_week numeric(4, 2);
alter table overhead_people add column if not exists hours_per_day numeric(5, 2);
alter table overhead_people add column if not exists nonbillable_hours_per_day numeric(5, 2);
alter table overhead_people add column if not exists annual_leave_days numeric(5, 2);
alter table overhead_people add column if not exists sick_days numeric(5, 2);
alter table overhead_people add column if not exists training_days numeric(5, 2);
alter table overhead_people add column if not exists other_costs_per_year numeric(12, 2);
-- The old yearly hours override: 0 meant "leave this person out", which is now 0 days a week.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'overhead_people' and column_name = 'hours_per_year') then
    update overhead_people set days_per_week = 0 where hours_per_year = 0;
    alter table overhead_people drop column hours_per_year;
  end if;
end $$;

-- INTERNAL (no caller check, not granted to anyone): the whole calculation, one row per active person, per year.
create or replace function overhead_people_calc(p_mode text default null)
returns table (
  profile_id uuid, full_name text, role text, billable boolean, subcontractor boolean,
  days_per_week numeric, hours_per_day numeric,
  paid_hours numeric, leave_hours numeric, training_hours numeric, nonbillable_hours numeric, billable_hours numeric,
  hourly_cost numeric, wages numeric, oncosts numeric,
  direct_total numeric, direct_rate numeric, indirect_total numeric, cost_per_billable_hour numeric,
  from_timesheets boolean, logged_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_mode text;
  v_oncost_lines numeric;
begin
  select * into s from overhead_settings where id = 1;
  v_mode := coalesce(p_mode, s.hours_mode);
  select coalesce(sum(l.annual_amount), 0) into v_oncost_lines from overhead_lines l where l.bucket = 'employee';
  return query
  with ts as (
    select t.staff_id,
      sum(x.h) as all_h,
      sum(case when t.time_category in ('training', 'tafe') then x.h else 0 end) as train_h,
      sum(case when t.time_category in ('job', 'training', 'tafe') then 0 else x.h end) as admin_h
    from time_entries t
    cross join lateral (select greatest(0, extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0) as h) x
    where t.clock_out is not null and t.clock_in >= now() - interval '12 months'
    group by t.staff_id),
  base as (
    select p.id as pid, p.full_name as pname, p.role as prole,
      coalesce(op.billable, p.role in ('staff', 'sales')) as is_billable,
      coalesce(op.subcontractor, false) as is_sc,
      coalesce(op.days_per_week, s.default_days_per_week) as dpw,
      coalesce(op.hours_per_day, s.default_hours_per_day) as hpd,
      coalesce(op.nonbillable_hours_per_day, s.default_nonbillable_hours_per_day) as nbpd,
      -- the default leave days are full time; part-timers get them pro rata to their days a week
      coalesce(op.annual_leave_days, s.default_annual_leave_days * least(coalesce(op.days_per_week, s.default_days_per_week), 5) / 5.0) as al,
      coalesce(op.sick_days, s.default_sick_days * least(coalesce(op.days_per_week, s.default_days_per_week), 5) / 5.0) as sl,
      coalesce(op.training_days, s.default_training_days) as td,
      coalesce(op.other_costs_per_year, 0) as other,
      coalesce(p.ordinary_rate, 0) as rate,
      coalesce(p.annual_salary, 0) as salary,
      coalesce(ts.all_h, 0) as all_h, coalesce(ts.train_h, 0) as train_h, coalesce(ts.admin_h, 0) as admin_h
    from profiles p
    left join overhead_people op on op.profile_id = p.id
    left join ts on ts.staff_id = p.id
    where p.active),
  d as (
    select b.*,
      52 * b.dpw * b.hpd as paid_h,
      -- subcontractors (and anyone on 0 days) get no paid leave, public holidays or training
      case when b.is_sc or b.dpw = 0 then 0 else s.public_holidays_per_year * least(b.dpw, 5) / 5.0 + b.al + b.sl end as leave_d,
      case when b.is_sc or b.dpw = 0 then 0 else b.al end as annual_d,
      case when b.is_sc or b.dpw = 0 then 0 else b.td end as train_d,
      (v_mode = 'timesheets' and b.all_h >= 40) as use_ts
    from base b),
  e as (
    select d.*,
      greatest(0, 52 * d.dpw - d.leave_d - d.train_d) as work_d,
      case when d.salary > 0 and d.paid_h > 0 then d.salary / d.paid_h else d.rate end as hr,
      case when d.salary > 0 then d.salary else d.paid_h * d.rate end as wage
    from d),
  f as (
    select e.*,
      e.work_d * e.hpd as avail_h,
      least(e.work_d * e.hpd, case when e.use_ts then e.work_d * e.hpd * e.admin_h / e.all_h else e.work_d * e.nbpd end) as nb_h,
      case when e.use_ts then e.work_d * e.hpd * e.train_h / e.all_h else 0 end as ts_train_h
    from e),
  w as (select coalesce(sum(f.wage) filter (where not f.is_sc), 0) as all_wages from f),
  g as (
    select f.*,
      case when f.is_billable then greatest(0, f.avail_h - f.nb_h - f.ts_train_h) else 0 end as bill_h,
      case when f.is_sc then f.other else
        f.wage * (s.super_pct + s.workers_comp_pct + s.payroll_tax_pct) / 100.0
        + f.annual_d * f.hpd * f.hr * s.leave_loading_pct / 100.0
        + case when w.all_wages > 0 then v_oncost_lines * f.wage / w.all_wages else 0 end
        + f.other end as oc
    from f cross join w),
  r as (
    select g.*,
      -- a billable person's leave, training and on-costs are their direct overhead; with no billable hours
      -- there is nothing to recover it from, so it falls into the shared (indirect) pool instead
      case when g.is_billable and g.bill_h > 0 then (g.leave_d * g.hpd + g.train_d * g.hpd + g.ts_train_h) * g.hr + g.oc else 0 end as dir,
      case when g.is_billable and g.bill_h > 0 then g.nb_h * g.hr else g.wage + g.oc end as ind
    from g)
  select r.pid, r.pname, r.prole, r.is_billable, r.is_sc, r.dpw, r.hpd,
    round(r.paid_h, 1), round(r.leave_d * r.hpd, 1), round(r.train_d * r.hpd + r.ts_train_h, 1), round(r.nb_h, 1), round(r.bill_h, 1),
    round(r.hr, 2), round(r.wage, 2), round(r.oc, 2),
    round(r.dir, 2),
    case when r.bill_h > 0 then round(r.dir / r.bill_h, 2) end,
    round(r.ind, 2),
    case when r.bill_h > 0 then round(r.hr + r.dir / r.bill_h, 2) end,
    r.use_ts, round(r.all_h, 1)
  from r;
end $$;
revoke all on function overhead_people_calc(text) from public, anon, authenticated;

-- INTERNAL: the company-wide rates. Also used by the nightly job (no user, so no caller check here).
create or replace function compute_overhead_rates()
returns table (
  direct_total numeric, direct_rate numeric, indirect_total numeric, indirect_rate numeric, billable_hours numeric,
  oncost_lines numeric, nonbillable_people_cost numeric,
  company_total numeric, company_pct numeric, company_basis text, mode text, timesheet_days int)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_dir numeric; v_ind numeric; v_hours numeric; v_nbp numeric; v_oc numeric; v_co numeric; v_first timestamptz;
begin
  select * into s from overhead_settings where id = 1;
  select coalesce(sum(c.direct_total), 0), coalesce(sum(c.indirect_total), 0), coalesce(sum(c.billable_hours), 0),
         coalesce(sum(c.indirect_total) filter (where not c.billable or c.billable_hours = 0), 0)
    into v_dir, v_ind, v_hours, v_nbp from overhead_people_calc() c;
  select coalesce(sum(l.annual_amount) filter (where l.bucket = 'employee'), 0), coalesce(sum(l.annual_amount) filter (where l.bucket = 'company'), 0)
    into v_oc, v_co from overhead_lines l;
  select min(t.clock_in) into v_first from time_entries t where t.clock_out is not null and t.clock_in >= now() - interval '12 months';
  return query select
    round(v_dir, 2),
    case when v_hours > 0 then round(v_dir / v_hours, 2) else 0::numeric end,
    round(v_ind, 2),
    case when v_hours > 0 then round(v_ind / v_hours, 2) else 0::numeric end,
    round(v_hours, 1), v_oc, round(v_nbp, 2),
    v_co,
    case when s.expected_annual_base > 0 then round(v_co / s.expected_annual_base * 100, 2) else 0::numeric end,
    s.company_basis, s.hours_mode,
    case when v_first is null then 0 else (now()::date - v_first::date) end;
end $$;
revoke all on function compute_overhead_rates() from public, anon, authenticated;

-- What the pages call (Finance and Admin only: anyone else gets no rows).
create or replace function get_overhead_rates()
returns table (
  direct_total numeric, direct_rate numeric, indirect_total numeric, indirect_rate numeric, billable_hours numeric,
  oncost_lines numeric, nonbillable_people_cost numeric,
  company_total numeric, company_pct numeric, company_basis text, mode text, timesheet_days int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_finance_role() then return; end if;
  return query select * from compute_overhead_rates();
end $$;
revoke all on function get_overhead_rates() from public, anon;
grant execute on function get_overhead_rates() to authenticated;

create or replace function get_overhead_people(p_mode text default null)
returns table (
  profile_id uuid, full_name text, role text, billable boolean, subcontractor boolean,
  days_per_week numeric, hours_per_day numeric,
  paid_hours numeric, leave_hours numeric, training_hours numeric, nonbillable_hours numeric, billable_hours numeric,
  hourly_cost numeric, wages numeric, oncosts numeric,
  direct_total numeric, direct_rate numeric, indirect_total numeric, cost_per_billable_hour numeric,
  from_timesheets boolean, logged_hours numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_finance_role() then return; end if;
  return query select * from overhead_people_calc(p_mode) c order by c.full_name;
end $$;
revoke all on function get_overhead_people(text) from public, anon;
grant execute on function get_overhead_people(text) to authenticated;

-- Employee overheads for one job (Finance and Admin only). Estimated uses the average direct rate plus the
-- indirect rate per quoted hour; actual uses each person's own direct rate on the job hours they logged.
create or replace function get_project_overheads(p_project_id uuid)
returns table (est_rate numeric, actual_amount numeric, actual_hours numeric, company_pct numeric, company_basis text)
language plpgsql stable security definer set search_path = public as $$
declare
  cr record;
begin
  if not is_finance_role() then return; end if;
  select * into cr from compute_overhead_rates();
  return query
  with hrs as (
    select t.staff_id, sum(greatest(0, extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0)) as h
    from time_entries t
    where t.project_id = p_project_id and t.clock_out is not null and t.time_category = 'job'
    group by t.staff_id)
  select cr.direct_rate + cr.indirect_rate,
    round(coalesce(sum(hrs.h * (coalesce(c.direct_rate, cr.direct_rate) + cr.indirect_rate)), 0), 2),
    round(coalesce(sum(hrs.h), 0), 2),
    cr.company_pct, cr.company_basis
  from hrs left join overhead_people_calc() c on c.profile_id = hrs.staff_id;
end $$;
revoke all on function get_project_overheads(uuid) from public, anon;
grant execute on function get_project_overheads(uuid) to authenticated;

-- Company-level month by month: what came in against everything it cost (estimated from invoices, received
-- materials, timesheets and the yearly overhead figures divided by 12).
create or replace function get_monthly_net_summary(p_months int default 12)
returns table (month date, revenue numeric, materials numeric, job_labour numeric, gross_profit numeric,
  direct_overheads numeric, indirect_wages numeric, company_costs numeric, net_profit numeric, job_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_dir numeric; v_nbp numeric; v_co numeric;
begin
  if not is_finance_role() then return; end if;
  select cr.direct_total, cr.nonbillable_people_cost, cr.company_total into v_dir, v_nbp, v_co from compute_overhead_rates() cr;
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
    -- billable people's non-job admin time each month (training is part of the direct overhead instead)
    select date_trunc('month', t.clock_in at time zone 'Australia/Sydney')::date as m,
      sum(case when t.time_category = 'job' then h.hrs else 0 end) as job_hours,
      sum(case when t.time_category = 'job' then h.hrs * coalesce(p.ordinary_rate, 0) else 0 end) as job_wages,
      sum(case when t.time_category not in ('job', 'training', 'tafe') and coalesce(op.billable, p.role in ('staff', 'sales')) then h.hrs * coalesce(p.ordinary_rate, 0) else 0 end) as nonjob_wages
    from time_entries t
    join profiles p on p.id = t.staff_id
    left join overhead_people op on op.profile_id = p.id
    cross join lateral (select extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0 as hrs) h
    where t.clock_out is not null group by 1)
  select mo.m,
    round(coalesce(rev.v, 0), 2), round(coalesce(mat.v, 0), 2), round(coalesce(tm.job_wages, 0), 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0), 2),
    round(v_dir / 12.0, 2),
    round(coalesce(tm.nonjob_wages, 0) + v_nbp / 12.0, 2),
    round(v_co / 12.0, 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0) - v_dir / 12.0 - coalesce(tm.nonjob_wages, 0) - v_nbp / 12.0 - v_co / 12.0, 2),
    round(coalesce(tm.job_hours, 0), 2)
  from months mo left join rev on rev.m = mo.m left join mat on mat.m = mo.m left join tm on tm.m = mo.m
  order by mo.m desc;
end $$;
revoke all on function get_monthly_net_summary(int) from public, anon;
grant execute on function get_monthly_net_summary(int) to authenticated;
