-- Overheads and net profit.
--
-- Two kinds of overhead, both kept as annual dollar amounts in overhead_lines:
--   employee: costs of having an employee on top of their wage (super, workers comp, payroll tax,
--             tools, vehicle, phone, uniforms, training...). Divided by the total PAID hours a year
--             to give $ per hour added to every employee's hourly rate (their "loaded" rate).
--   company:  the costs of running the business (rent, insurance, accounting, software, marketing,
--             office wages...). Divided by the total BILLABLE hours a year to give $ per hour of
--             job labour that the business must earn to cover them.
-- Net profit on a job = gross profit - employee overhead on its hours - company overhead on its hours.
--
-- Lines can be typed in by hand (source = 'manual') or kept live from the Xero Profit and Loss report
-- (source = 'xero'): overhead_xero_map says which Xero expense account belongs to which bucket, and
-- sync-overheads / the nightly job rewrite the xero lines from the report.
--
-- Everything here is finance-only (admin and finance roles). Staff and sales cannot read it.

create table if not exists overhead_lines (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('employee', 'company')),
  name text not null,
  annual_amount numeric(14, 2) not null default 0,
  source text not null default 'manual' check (source in ('manual', 'xero')),
  xero_account_id text,
  xero_account_code text,
  note text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists overhead_lines_xero_account_idx on overhead_lines (xero_account_id) where xero_account_id is not null;

create table if not exists overhead_xero_map (
  account_id text primary key,
  account_code text,
  account_name text not null,
  bucket text not null check (bucket in ('employee', 'company', 'ignore')),
  updated_at timestamptz not null default now()
);

create table if not exists overhead_settings (
  id int primary key default 1 check (id = 1),
  hours_mode text not null default 'manual' check (hours_mode in ('manual', 'timesheets')),
  paid_hours_per_year numeric(12, 2) not null default 0,
  billable_hours_per_year numeric(12, 2) not null default 0,
  xero_months int not null default 12 check (xero_months between 1 and 24),
  auto_sync boolean not null default true,
  last_synced_at timestamptz,
  last_sync_error text,
  updated_at timestamptz not null default now()
);
insert into overhead_settings (id) values (1) on conflict (id) do nothing;

alter table overhead_lines enable row level security;
alter table overhead_xero_map enable row level security;
alter table overhead_settings enable row level security;
drop policy if exists "finance full access on overhead_lines" on overhead_lines;
create policy "finance full access on overhead_lines" on overhead_lines for all to authenticated using (is_finance_role()) with check (is_finance_role());
drop policy if exists "finance full access on overhead_xero_map" on overhead_xero_map;
create policy "finance full access on overhead_xero_map" on overhead_xero_map for all to authenticated using (is_finance_role()) with check (is_finance_role());
drop policy if exists "finance full access on overhead_settings" on overhead_settings;
create policy "finance full access on overhead_settings" on overhead_settings for all to authenticated using (is_finance_role()) with check (is_finance_role());

-- Hours the rates are spread over. In 'manual' mode: the two numbers typed into overhead_settings.
-- In 'timesheets' mode: the last 12 months of finished timesheet entries (paid = every entry,
-- billable = entries logged against a job), scaled up to a full year if there is less history.
create or replace function overhead_hours_basis()
returns table (paid_hours numeric, billable_hours numeric, mode text)
language plpgsql stable security definer set search_path = public as $$
declare
  s overhead_settings%rowtype;
  v_first timestamptz;
  v_scale numeric := 1;
  v_paid numeric; v_bill numeric;
begin
  if not is_finance_role() then return; end if;
  select * into s from overhead_settings where id = 1;
  if s.hours_mode = 'timesheets' then
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
revoke all on function overhead_hours_basis() from public, anon;
grant execute on function overhead_hours_basis() to authenticated;

-- The two hourly rates, ready to use. Finance-only (returns nothing to anyone else).
create or replace function get_overhead_rates()
returns table (employee_rate numeric, company_rate numeric, employee_total numeric, company_total numeric, paid_hours numeric, billable_hours numeric, mode text)
language plpgsql stable security definer set search_path = public as $$
declare
  b record;
  v_emp numeric; v_co numeric;
begin
  if not is_finance_role() then return; end if;
  select * into b from overhead_hours_basis();
  select coalesce(sum(annual_amount) filter (where bucket = 'employee'), 0), coalesce(sum(annual_amount) filter (where bucket = 'company'), 0)
    into v_emp, v_co from overhead_lines;
  return query select
    case when b.paid_hours > 0 then round(v_emp / b.paid_hours, 2) else 0::numeric end,
    case when b.billable_hours > 0 then round(v_co / b.billable_hours, 2) else 0::numeric end,
    v_emp, v_co, b.paid_hours, b.billable_hours, b.mode;
end $$;
revoke all on function get_overhead_rates() from public, anon;
grant execute on function get_overhead_rates() to authenticated;
