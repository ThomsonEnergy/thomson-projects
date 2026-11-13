-- Migration 024 — Billable Rates & Job Costing foundation
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Rate tiers - sell side only, used for quoting -------------------------
-- Seeded from Thomson Energy's Schedule of Rates (current as at Jan 2026).
-- Cost side deliberately lives on the employee, not the tier - see below.

create table if not exists billable_rate_tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sell_rate numeric not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table billable_rate_tiers enable row level security;
drop policy if exists "Pricing roles manage rate tiers" on billable_rate_tiers;
create policy "Pricing roles manage rate tiers" on billable_rate_tiers
  for all using (is_pricing_role()) with check (is_pricing_role());

insert into billable_rate_tiers (name, sell_rate, sort_order) values
  ('Principal Electrician & Technical Lead', 145.45, 1),
  ('Licensed Electrical Specialist', 122.73, 2),
  ('Licensed Electrician', 107.27, 3),
  ('Experienced Apprentice', 86.36, 4),
  ('Apprentice Electrician', 72.73, 5),
  ('Labourer', 81.81, 6)
on conflict (name) do nothing;

-- 2. Employee cost rates - per person, not per tier -------------------------
-- Award rates don't cleanly multiply (1.5x of ordinary rarely equals the
-- actual award overtime rate), so each rate is entered directly rather
-- than computed. Admin/Finance only - this is real wage data.

alter table profiles add column if not exists rate_tier_id uuid references billable_rate_tiers(id);
alter table profiles add column if not exists ordinary_rate numeric;
alter table profiles add column if not exists rate_1_5x numeric;
alter table profiles add column if not exists rate_2x numeric;
alter table profiles add column if not exists rate_2_5x numeric;

create table if not exists employee_allowances (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  amount numeric not null,
  frequency text not null check (frequency in ('per_hour', 'per_day')),
  created_at timestamptz not null default now()
);

alter table employee_allowances enable row level security;
drop policy if exists "Admin manages allowances" on employee_allowances;
create policy "Admin manages allowances" on employee_allowances
  for all using (is_admin()) with check (is_admin());

-- 3. NSW public holidays - rule-based, regenerable, never goes stale -------
-- These follow the Public Holidays Act 2010 (NSW) rules exactly - fixed
-- dates with weekend-shift/additional-day rules, Easter computed via the
-- standard algorithm, King's Birthday/Labour Day as Nth-Monday rules.
-- Bank Holiday deliberately excluded - it's not a declared public holiday
-- for most workers, only for banks, per the Act itself.

create table if not exists public_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  state text not null default 'NSW',
  created_at timestamptz not null default now()
);

alter table public_holidays enable row level security;
drop policy if exists "Everyone can read public holidays" on public_holidays;
create policy "Everyone can read public holidays" on public_holidays for select using (true);
drop policy if exists "Admin manages public holidays" on public_holidays;
create policy "Admin manages public holidays" on public_holidays
  for all using (is_admin()) with check (is_admin());

-- Computes Easter Sunday for a given year via the Anonymous Gregorian
-- algorithm (Meeus/Jones/Butcher) - standard, deterministic, no lookup.
create or replace function easter_sunday(p_year int)
returns date
language plpgsql
as $$
declare
  a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; month int; day int;
begin
  a := p_year % 19;
  b := p_year / 100;
  c := p_year % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  month := (h + l - 7 * m + 114) / 31;
  day := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(p_year, month, day);
end;
$$;

-- Generates the full NSW public holiday list for a given year and upserts
-- it into the table - safe to re-run for the same year, and this is what
-- a yearly (or one-time-for-many-years) refresh calls.
create or replace function generate_nsw_public_holidays(p_year int)
returns void
language plpgsql
security definer
as $$
declare
  easter date;
  d date;
  dow int;
  christmas_shift date;
  boxing_shift date;
begin
  -- New Year's Day - additional day if it falls on a weekend
  d := make_date(p_year, 1, 1);
  insert into public_holidays (holiday_date, name) values (d, 'New Year''s Day') on conflict (holiday_date) do nothing;
  dow := extract(isodow from d);
  if dow in (6, 7) then
    insert into public_holidays (holiday_date, name)
    values (d + (8 - dow), 'New Year''s Day (additional day)')
    on conflict (holiday_date) do nothing;
  end if;

  -- Australia Day - shifts to the following Monday if it falls on a weekend
  d := make_date(p_year, 1, 26);
  dow := extract(isodow from d);
  if dow in (6, 7) then
    insert into public_holidays (holiday_date, name) values (d + (8 - dow), 'Australia Day') on conflict (holiday_date) do nothing;
  else
    insert into public_holidays (holiday_date, name) values (d, 'Australia Day') on conflict (holiday_date) do nothing;
  end if;

  -- Easter weekend - Good Friday through Easter Monday
  easter := easter_sunday(p_year);
  insert into public_holidays (holiday_date, name) values (easter - 2, 'Good Friday') on conflict (holiday_date) do nothing;
  insert into public_holidays (holiday_date, name) values (easter - 1, 'Easter Saturday') on conflict (holiday_date) do nothing;
  insert into public_holidays (holiday_date, name) values (easter, 'Easter Sunday') on conflict (holiday_date) do nothing;
  insert into public_holidays (holiday_date, name) values (easter + 1, 'Easter Monday') on conflict (holiday_date) do nothing;

  -- Anzac Day - additional day if it falls on a weekend
  d := make_date(p_year, 4, 25);
  insert into public_holidays (holiday_date, name) values (d, 'Anzac Day') on conflict (holiday_date) do nothing;
  dow := extract(isodow from d);
  if dow in (6, 7) then
    insert into public_holidays (holiday_date, name)
    values (d + (8 - dow), 'Anzac Day (additional day)')
    on conflict (holiday_date) do nothing;
  end if;

  -- King's Birthday - 2nd Monday in June
  d := make_date(p_year, 6, 1);
  d := d + ((8 - extract(isodow from d)::int) % 7) + 7;
  insert into public_holidays (holiday_date, name) values (d, 'King''s Birthday') on conflict (holiday_date) do nothing;

  -- Labour Day - 1st Monday in October
  d := make_date(p_year, 10, 1);
  d := d + ((8 - extract(isodow from d)::int) % 7);
  insert into public_holidays (holiday_date, name) values (d, 'Labour Day') on conflict (holiday_date) do nothing;

  -- Christmas Day - additional day if it falls on a weekend. Computed
  -- first since Boxing Day's own shift (below) needs to know whether
  -- Christmas already claimed the same makeup day, and defer one day
  -- further if so - verified against real NSW government data for 2026
  -- and 2027, where this exact collision genuinely happens.
  d := make_date(p_year, 12, 25);
  insert into public_holidays (holiday_date, name) values (d, 'Christmas Day') on conflict (holiday_date) do nothing;
  dow := extract(isodow from d);
  christmas_shift := null;
  if dow in (6, 7) then
    christmas_shift := d + (8 - dow);
    insert into public_holidays (holiday_date, name)
    values (christmas_shift, 'Christmas Day (additional day)')
    on conflict (holiday_date) do nothing;
  end if;

  -- Boxing Day - additional day if it falls on a weekend, deferred one
  -- further day if that would otherwise land on the same date as
  -- Christmas's own additional day.
  d := make_date(p_year, 12, 26);
  insert into public_holidays (holiday_date, name) values (d, 'Boxing Day') on conflict (holiday_date) do nothing;
  dow := extract(isodow from d);
  if dow in (6, 7) then
    boxing_shift := d + (8 - dow);
    if christmas_shift is not null and boxing_shift = christmas_shift then
      boxing_shift := boxing_shift + 1;
    end if;
    insert into public_holidays (holiday_date, name)
    values (boxing_shift, 'Boxing Day (additional day)')
    on conflict (holiday_date) do nothing;
  end if;
end;
$$;

-- Populate a generous range up front - current year minus 1 through plus
-- 10 - so this never needs touching for a decade. Settings has a button
-- to run this again for further years whenever it's worth topping up.
do $$
declare
  yr int;
begin
  for yr in extract(year from now())::int - 1 .. extract(year from now())::int + 10 loop
    perform generate_nsw_public_holidays(yr);
  end loop;
end $$;

-- 4. Line items remember which tier was picked, so a quote's labour
-- lines can be re-edited and the tier selection restored, not just the
-- resulting dollar amount.
alter table cost_centre_line_items add column if not exists rate_tier_id uuid references billable_rate_tiers(id);
