-- Item 105, website prices built like a quote (owner's "Yes build", 21 Nov 2026).
--
-- The public website (repo website-updates-9e18ed) shows about 17 figures: package prices, two
-- guide rates and the off-grid ranges. Each is one row in website_packages, named by the key the
-- website uses for it. A row with lines (Stock items, prebuilds, labour on a rate tier) is priced
-- the way a quote stage is: materials x (1 + markup) + labour, plus 10% GST, less the STC and
-- battery STC credits. Lines are links, not copies, so the price is always worked out from
-- today's costs. A row with no lines shows its typed price. A row can follow another
-- (the top of a range, a per kW rate) once the row it follows has been built.
--
-- Publishing copies the figures into company_settings.website_prices_published. The website's
-- build reads only that, through get_website_prices(), which needs no login.
--
-- Additions only. No money or stock moves, no payroll. RLS: two new tables, pricing roles only.
-- Also here because both this and item 58 need it: the STC price paid to the customer as one
-- setting, and the battery STC factor by date with bstc_quantity().

-- ---------------------------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------------------------
-- What we pay the customer per STC and per battery STC (quotes default to the same 35 today).
alter table public.company_settings add column if not exists stc_credit_price numeric not null default 35 check (stc_credit_price >= 0);

-- The Cheaper Home Batteries factor per usable kWh, by period (DCCEEW schedule, confirmed
-- 6 Nov 2026, backlog item 58). t1, t2, t3 are the share of the factor paid on 0 to 14 kWh,
-- over 14 to 28 kWh and over 28 to 50 kWh. The scheme ends with 2030.
alter table public.company_settings add column if not exists bstc_factors jsonb not null default '[
  {"from": "2025-07-01", "factor": 9.3, "t1": 100, "t2": 100, "t3": 100},
  {"from": "2026-01-01", "factor": 8.4, "t1": 100, "t2": 100, "t3": 100},
  {"from": "2026-05-01", "factor": 6.8, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2027-01-01", "factor": 5.7, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2027-07-01", "factor": 5.2, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2028-01-01", "factor": 4.6, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2028-07-01", "factor": 4.1, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2029-01-01", "factor": 3.6, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2029-07-01", "factor": 3.1, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2030-01-01", "factor": 2.6, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2030-07-01", "factor": 2.1, "t1": 100, "t2": 60, "t3": 15},
  {"from": "2031-01-01", "factor": 0, "t1": 100, "t2": 60, "t3": 15}
]'::jsonb;

-- Website figures are rounded to this many dollars.
alter table public.company_settings add column if not exists website_price_rounding numeric not null default 50 check (website_price_rounding > 0);
-- The nightly run publishes a cost move under this percent by itself; a bigger one waits for a person.
alter table public.company_settings add column if not exists website_price_hold_percent numeric not null default 5 check (website_price_hold_percent >= 0);
-- What the website shows now: {"prices": {key: dollars}, "pre_credit": {key: dollars}, "held": {...}, "published_at": ..., "published_by": ..., "checked_at": ...}.
alter table public.company_settings add column if not exists website_prices_published jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------------------------
-- 2. Battery STCs from usable kWh (the count, rounded down), for a date (default today in Sydney)
-- ---------------------------------------------------------------------------------------------
create or replace function public.bstc_quantity(p_usable_kwh numeric, p_on date default null)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce((
    select floor(
        least(greatest(p_usable_kwh, 0), 14) * f.factor * f.t1 / 100
      + least(greatest(p_usable_kwh - 14, 0), 14) * f.factor * f.t2 / 100
      + least(greatest(p_usable_kwh - 28, 0), 22) * f.factor * f.t3 / 100)
    from (
      select (r->>'factor')::numeric as factor,
             coalesce((r->>'t1')::numeric, 100) as t1,
             coalesce((r->>'t2')::numeric, 100) as t2,
             coalesce((r->>'t3')::numeric, 100) as t3
      from company_settings cs, jsonb_array_elements(cs.bstc_factors) r
      where cs.id = 1 and (r->>'from')::date <= coalesce(p_on, sydney_today())
      order by (r->>'from')::date desc
      limit 1) f), 0)::integer;
$$;
revoke execute on function public.bstc_quantity(numeric, date) from public, anon;
grant execute on function public.bstc_quantity(numeric, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The packages and their lines
-- ---------------------------------------------------------------------------------------------
create table if not exists public.website_packages (
  id uuid primary key default gen_random_uuid(),
  price_key text not null unique check (price_key ~ '^[a-z0-9_]+$'),   -- the website's name for this figure (src/prices.json)
  name text not null,
  group_name text not null,
  sort_order integer not null default 0,
  typed_price numeric not null default 0 check (typed_price >= 0),     -- shown until the row has lines
  solar_kw numeric check (solar_kw is null or solar_kw > 0),           -- for the STC credit
  battery_usable_kwh numeric check (battery_usable_kwh is null or battery_usable_kwh > 0),   -- for the battery STC credit
  stc_zone_rating numeric not null default 1.382 check (stc_zone_rating > 0),               -- zone 3, Sydney to the Gold Coast
  markup_percent numeric check (markup_percent is null or markup_percent >= 0),             -- empty = the company default
  -- A row that follows another: that row's price, divided (a per kW rate) and/or added to (the top of a range).
  follows_key text references public.website_packages(price_key) on update cascade on delete set null,
  follows_divide numeric check (follows_divide is null or follows_divide > 0),
  follows_add numeric,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists website_packages_follows on public.website_packages (follows_key);
create index if not exists website_packages_updated_by on public.website_packages (updated_by);

create table if not exists public.website_package_lines (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.website_packages(id) on delete cascade,
  item_type text not null check (item_type in ('material', 'prebuild', 'labour')),
  -- The live link. If the Stock item, prebuild or rate tier is deleted the link empties, the line
  -- stays, and the package keeps its last published price until a person fixes it.
  material_id uuid references public.materials(id) on delete set null,
  prebuild_id uuid references public.prebuilds(id) on delete set null,
  rate_tier_id uuid references public.billable_rate_tiers(id) on delete set null,
  quantity numeric not null default 1 check (quantity > 0),             -- units, prebuilds, or labour hours
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (num_nonnulls(material_id, prebuild_id, rate_tier_id) <= 1)
);
create index if not exists website_package_lines_package on public.website_package_lines (package_id);
create index if not exists website_package_lines_material on public.website_package_lines (material_id);
create index if not exists website_package_lines_prebuild on public.website_package_lines (prebuild_id);
create index if not exists website_package_lines_rate_tier on public.website_package_lines (rate_tier_id);

alter table public.website_packages enable row level security;
alter table public.website_package_lines enable row level security;
revoke all on public.website_packages from public, anon, authenticated;
revoke all on public.website_package_lines from public, anon, authenticated;
-- The rows are the website's own list of figures, added by a migration: people change them, never add or delete.
grant select, update on public.website_packages to authenticated;
grant select, insert, update, delete on public.website_package_lines to authenticated;

drop policy if exists "Pricing roles read website packages" on public.website_packages;
create policy "Pricing roles read website packages" on public.website_packages
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles change website packages" on public.website_packages;
create policy "Pricing roles change website packages" on public.website_packages
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));

drop policy if exists "Pricing roles read website package lines" on public.website_package_lines;
create policy "Pricing roles read website package lines" on public.website_package_lines
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add website package lines" on public.website_package_lines;
create policy "Pricing roles add website package lines" on public.website_package_lines
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change website package lines" on public.website_package_lines;
create policy "Pricing roles change website package lines" on public.website_package_lines
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles delete website package lines" on public.website_package_lines;
create policy "Pricing roles delete website package lines" on public.website_package_lines
  for delete to authenticated using ((select is_pricing_role()));

-- A change to a package or its lines stamps the package, so the nightly run can tell a draft a
-- person is still working on (changed since the last Publish) from a price that moved by itself.
create or replace function public.website_package_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'website_packages' then
    new.updated_at := now();
    new.updated_by := coalesce((select auth.uid()), new.updated_by);
    return new;
  end if;
  if tg_op = 'INSERT' then
    update website_packages set updated_at = now() where id = new.package_id;
  elsif tg_op = 'DELETE' then
    update website_packages set updated_at = now() where id = old.package_id;
  else
    update website_packages set updated_at = now() where id in (new.package_id, old.package_id);
  end if;
  return null;
end;
$$;
revoke execute on function public.website_package_touch() from public, anon, authenticated;

drop trigger if exists trg_website_packages_touch on public.website_packages;
create trigger trg_website_packages_touch before update on public.website_packages
  for each row when (pg_trigger_depth() = 0) execute function public.website_package_touch();
drop trigger if exists trg_website_package_lines_touch on public.website_package_lines;
create trigger trg_website_package_lines_touch after insert or update or delete on public.website_package_lines
  for each row execute function public.website_package_touch();

-- The figures the website shows today (src/prices.json in the website repo, live 21 Nov 2026).
-- Nothing changes on the website until a package is given lines and published.
insert into public.website_packages (price_key, name, group_name, sort_order, typed_price, solar_kw, battery_usable_kwh, follows_key, follows_divide, follows_add) values
  ('solar_63_from',  '6.3 kW solar',                         'Solar',           10,  6500,  6.3,  null,  null, null, null),
  ('solar_102_from', '10.2 kW solar',                        'Solar',           20,  9500,  10.2, null,  null, null, null),
  ('solar_131_from', '13.1 kW solar',                        'Solar',           30,  12000, 13.1, null,  null, null, null),
  ('hybrid_102_9',   '10.2 kW solar + 9 kWh battery',        'Solar + battery', 40,  14700, 10.2, 8.76,  null, null, null),
  ('hybrid_132_18',  '13.2 kW solar + 18 kWh battery',       'Solar + battery', 50,  22200, 13.2, 17.52, null, null, null),
  ('battery_9',      '9 kWh battery added to existing solar',  'Batteries',     60,  5750,  null, 8.76,  null, null, null),
  ('battery_18',     '18 kWh battery added to existing solar', 'Batteries',     70,  9000,  null, 17.52, null, null, null),
  ('battery_27',     '27 kWh battery added to existing solar', 'Batteries',     80,  13500, null, 26.28, null, null, null),
  ('offgrid_weekender_from', 'Off-grid weekender, from',       'Off-grid',      90,  15000, null, null,  null, null, null),
  ('offgrid_home_from',      'Off-grid full-time home, from',  'Off-grid',      100, 25000, null, null,  null, null, null),
  ('offgrid_home_to',        'Off-grid full-time home, up to', 'Off-grid',      110, 55000, null, null,  null, null, null),
  ('offgrid_large_from',     'Off-grid large property, from',  'Off-grid',      120, 65000, null, null,  null, null, null),
  ('solar_63_to',    '6.3 kW solar, top of the range',       'Follows a package', 130, 8500,  null, null, 'solar_63_from',  null, 2000),
  ('solar_102_to',   '10.2 kW solar, top of the range',      'Follows a package', 140, 12500, null, null, 'solar_102_from', null, 3000),
  ('solar_131_to',   '13.1 kW solar, top of the range',      'Follows a package', 150, 15500, null, null, 'solar_131_from', null, 3500),
  ('solar_per_kw',   'Solar guide, per kW',                  'Follows a package', 160, 1000,  null, null, 'solar_102_from', 10.2, null),
  ('battery_per_kwh', 'Battery guide, per kWh',              'Follows a package', 170, 500,   null, null, 'battery_27',     27,   null)
on conflict (price_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 4. Every figure, worked out now. One row per package with the working shown.
--    source: built (has lines), follows (the row it follows is built), typed, or broken (a line's
--    item was deleted: the last published price stands until a person fixes it).
-- ---------------------------------------------------------------------------------------------
create or replace function public.website_package_figures()
returns jsonb
language sql
stable
set search_path = public
as $$
  with s as (
    select default_markup_percent, stc_credit_price, website_price_rounding as rounding,
           website_prices_published->'prices' as published
    from company_settings where id = 1
  ),
  line_sums as (
    select l.package_id,
           count(*) as line_count,
           count(*) filter (where (l.item_type = 'material' and m.id is null)
                               or (l.item_type = 'prebuild' and p.id is null)
                               or (l.item_type = 'labour' and t.id is null)) as missing,
           coalesce(sum(case when l.item_type = 'material' then l.quantity * m.cost_price
                             when l.item_type = 'prebuild' then l.quantity * pb.materials else 0 end), 0) as materials_cost,
           coalesce(sum(case when l.item_type = 'labour' then l.quantity * t.sell_rate
                             when l.item_type = 'prebuild' then l.quantity * pb.labour else 0 end), 0) as labour
    from website_package_lines l
    left join materials m on m.id = l.material_id
    left join prebuilds p on p.id = l.prebuild_id
    left join billable_rate_tiers t on t.id = l.rate_tier_id
    left join lateral (
      select coalesce(sum(c.quantity * c.unit_cost) filter (where c.item_type = 'material'), 0) as materials,
             coalesce(sum(c.quantity * c.unit_cost) filter (where c.item_type = 'labour'), 0) as labour
      from prebuild_components c where c.prebuild_id = l.prebuild_id) pb on true
    group by l.package_id
  ),
  worked as (
    select k.*,
           coalesce(ls.line_count, 0) as line_count,
           coalesce(ls.missing, 0) as missing,
           coalesce(ls.materials_cost, 0) as materials_cost,
           coalesce(ls.labour, 0) as labour,
           coalesce(k.markup_percent, s.default_markup_percent) as markup_used,
           case when k.solar_kw is null then 0
                else floor(k.solar_kw * k.stc_zone_rating * greatest(0, 2031 - extract(year from sydney_today())))::integer end as stc_count,
           case when k.battery_usable_kwh is null then 0 else bstc_quantity(k.battery_usable_kwh) end as bstc_count
    from website_packages k cross join s
    left join line_sums ls on ls.package_id = k.id
  ),
  priced as (
    select w.*,
           round((w.materials_cost * (1 + w.markup_used / 100) + w.labour) * 1.1, 2) as inc_gst,
           (w.stc_count + w.bstc_count) * s.stc_credit_price as credit
    from worked w cross join s
  ),
  resolved as (
    select p.*,
           case when p.line_count > 0 and p.missing > 0 then 'broken'
                when p.line_count > 0 then 'built'
                when b.price_key is not null and b.line_count > 0 and b.missing = 0 then 'follows'
                else 'typed' end as source,
           (b.inc_gst - b.credit) as base_customer,
           b.inc_gst as base_inc_gst
    from priced p left join priced b on b.price_key = p.follows_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'price_key', r.price_key, 'name', r.name, 'group_name', r.group_name,
      'typed_price', r.typed_price, 'solar_kw', r.solar_kw, 'battery_usable_kwh', r.battery_usable_kwh,
      'markup_percent', r.markup_percent, 'markup_used', r.markup_used,
      'follows_key', r.follows_key, 'follows_divide', r.follows_divide, 'follows_add', r.follows_add,
      'updated_at', r.updated_at, 'source', r.source, 'line_count', r.line_count, 'missing', r.missing,
      'materials_cost', round(r.materials_cost, 2), 'labour', round(r.labour, 2),
      'ex_gst', round(r.materials_cost * (1 + r.markup_used / 100) + r.labour, 2), 'inc_gst', r.inc_gst,
      'stc_count', r.stc_count, 'bstc_count', r.bstc_count, 'credit', r.credit,
      'customer_price', case when r.source = 'built' then r.inc_gst - r.credit end,
      -- before the credits: what the nightly run compares, so a rebate change never waits for a person
      'pre_credit', case r.source
          when 'built' then r.inc_gst
          when 'follows' then round(r.base_inc_gst / coalesce(r.follows_divide, 1) + coalesce(r.follows_add, 0), 2)
          else r.typed_price end,
      'website_price', case r.source
          when 'built' then greatest(0, round((r.inc_gst - r.credit) / s.rounding) * s.rounding)
          when 'follows' then greatest(0, round((r.base_customer / coalesce(r.follows_divide, 1) + coalesce(r.follows_add, 0)) / s.rounding) * s.rounding)
          when 'broken' then coalesce((s.published->>r.price_key)::numeric, r.typed_price)
          else r.typed_price end
    ) order by r.sort_order, r.price_key), '[]'::jsonb)
  from resolved r cross join s;
$$;
revoke execute on function public.website_package_figures() from public, anon;
grant execute on function public.website_package_figures() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Publish. Called by the server only (netlify/functions/publish-website-prices.js after
--    requirePricingRole, and the nightly run), which then asks Netlify to rebuild the website.
--    p_auto = false: a person pressed Publish, everything goes.
--    p_auto = true (nightly): a package changed since the last Publish is a draft and waits; a
--    built price whose cost side moved by the hold percent or more waits and is listed in "held";
--    everything else (small cost moves, any rebate change) goes by itself.
-- ---------------------------------------------------------------------------------------------
create or replace function public.publish_website_prices(p_by uuid default null, p_auto boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_hold numeric;
  v_published_at timestamptz;
  v_prices jsonb := '{}'::jsonb;
  v_pre jsonb := '{}'::jsonb;
  v_held jsonb := '{}'::jsonb;
  v_changed jsonb := '{}'::jsonb;
  v_drafts jsonb := '[]'::jsonb;
  r jsonb;
  v_key text;
  v_new numeric;
  v_new_pre numeric;
  v_old_price numeric;
  v_old_pre numeric;
begin
  select website_prices_published, website_price_hold_percent into v_old, v_hold
    from company_settings where id = 1 for update;
  v_published_at := (v_old->>'published_at')::timestamptz;

  -- The nightly run never does the first publish: until a person has pressed Publish once, the
  -- website keeps its own figures.
  if p_auto and v_published_at is null then
    return jsonb_build_object('changed', '{}'::jsonb, 'held', '{}'::jsonb, 'drafts', '[]'::jsonb, 'prices', '{}'::jsonb, 'never_published', true);
  end if;

  for r in select * from jsonb_array_elements(website_package_figures()) loop
    v_key := r->>'price_key';
    v_new := (r->>'website_price')::numeric;
    v_new_pre := (r->>'pre_credit')::numeric;
    v_old_price := (v_old->'prices'->>v_key)::numeric;
    v_old_pre := (v_old->'pre_credit'->>v_key)::numeric;

    if p_auto and v_old_price is not null and v_published_at is not null
       and (r->>'updated_at')::timestamptz > v_published_at then
      -- a person changed this package and has not pressed Publish yet
      v_drafts := v_drafts || to_jsonb(v_key);
      v_prices := v_prices || jsonb_build_object(v_key, v_old_price);
      v_pre := v_pre || jsonb_build_object(v_key, coalesce(v_old_pre, v_old_price));
    elsif p_auto and v_old_price is not null and r->>'source' in ('built', 'follows')
       and coalesce(v_old_pre, 0) > 0 and v_new is distinct from v_old_price
       and abs(v_new_pre - v_old_pre) / v_old_pre * 100 >= v_hold then
      v_held := v_held || jsonb_build_object(v_key, jsonb_build_object(
        'from', v_old_price, 'to', v_new,
        'since', coalesce(v_old->'held'->v_key->>'since', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
      v_prices := v_prices || jsonb_build_object(v_key, v_old_price);
      v_pre := v_pre || jsonb_build_object(v_key, v_old_pre);
    else
      v_prices := v_prices || jsonb_build_object(v_key, v_new);
      v_pre := v_pre || jsonb_build_object(v_key, v_new_pre);
      if v_new is distinct from v_old_price then
        v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('from', v_old_price, 'to', v_new));
      end if;
    end if;
  end loop;

  update company_settings set website_prices_published = jsonb_build_object(
      'prices', v_prices, 'pre_credit', v_pre, 'held', v_held,
      'published_at', case when p_auto then to_jsonb(v_published_at) else to_jsonb(now()) end,
      'published_by', case when p_auto then v_old->'published_by' else to_jsonb(p_by) end,
      'changed_at', case when v_changed <> '{}'::jsonb then to_jsonb(now()) else coalesce(v_old->'changed_at', 'null'::jsonb) end,
      'checked_at', to_jsonb(now()))
    where id = 1;

  return jsonb_build_object('changed', v_changed, 'held', v_held, 'drafts', v_drafts, 'prices', v_prices);
end;
$$;
revoke execute on function public.publish_website_prices(uuid, boolean) from public, anon, authenticated;
grant execute on function public.publish_website_prices(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. What the website's build reads. No login: these are the prices printed on the public site.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_website_prices()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select website_prices_published->'prices' from company_settings where id = 1), '{}'::jsonb);
$$;
revoke execute on function public.get_website_prices() from public, anon, authenticated;
grant execute on function public.get_website_prices() to anon, authenticated;
