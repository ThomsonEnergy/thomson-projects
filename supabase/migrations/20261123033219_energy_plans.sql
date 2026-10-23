-- Retail plan suggestions (docs/IDEAS_BACKLOG.md item 34): every retailer's published residential and
-- business electricity market plans on the NSW, ACT and QLD networks, from the AER's Consumer Data
-- Right product data (the data behind Energy Made Easy), refreshed nightly by
-- sync-energy-plans-background.js. Public data: read by staff, written only by the server (the
-- service role, so there are no write policies).

create table if not exists public.energy_plans (
  plan_id text primary key,
  brand text not null,
  brand_name text,
  display_name text,
  customer_type text,
  pricing_model text,
  distributors text[] not null default '{}',
  included_postcodes text[] not null default '{}',
  excluded_postcodes text[] not null default '{}',
  effective_from timestamptz,
  effective_to timestamptz,
  last_updated timestamptz,
  roi_plan jsonb,
  adjust jsonb,
  notes jsonb,
  costable boolean not null default false,
  active boolean not null default true,
  fetched_at timestamptz not null default now()
);
comment on column public.energy_plans.roi_plan is 'The plan in the savings estimate''s terms (public/js/solar-roi.js roiPlan): c/kWh and c/day inc GST, feed-in c/kWh, time windows';
comment on column public.energy_plans.adjust is 'Guaranteed discounts and recurring fees applied when costing: percent_of_use, percent_of_bill, annual_fees';
comment on column public.energy_plans.notes is 'Shown with the plan: cannot_cost reasons, conditions, eligibility, model notes';

create index if not exists energy_plans_postcodes_idx on public.energy_plans using gin (included_postcodes);
create index if not exists energy_plans_distributors_idx on public.energy_plans using gin (distributors);
create index if not exists energy_plans_active_idx on public.energy_plans (active, customer_type);

create table if not exists public.energy_plan_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  source text,
  brands integer not null default 0,
  plans_listed integer not null default 0,
  plans_fetched integer not null default 0,
  plans_saved integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  samples jsonb not null default '{}'::jsonb
);
create index if not exists energy_plan_sync_runs_started_idx on public.energy_plan_sync_runs (started_at desc);

alter table public.energy_plans enable row level security;
alter table public.energy_plan_sync_runs enable row level security;

drop policy if exists "Staff read energy plans" on public.energy_plans;
create policy "Staff read energy plans" on public.energy_plans for select to authenticated using (true);

drop policy if exists "Staff read energy plan sync runs" on public.energy_plan_sync_runs;
create policy "Staff read energy plan sync runs" on public.energy_plan_sync_runs for select to authenticated using (true);
