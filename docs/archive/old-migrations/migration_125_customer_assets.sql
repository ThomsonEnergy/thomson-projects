-- Customer asset list: what we've installed for whom (solar, batteries,
-- inverters, generators, switchboards...), with warranty and servicing dates,
-- so we can remind customers when a service/panel clean is due or a warranty
-- is running out, and email owners of a type of equipment (e.g. everyone with
-- a hybrid inverter) when there's news. asset_reminder_log records every
-- email sent (or skipped) so nobody gets nagged twice.
create table if not exists customer_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  client_name text,
  site_address text,
  asset_type text not null default 'other'
    check (asset_type in ('solar', 'battery', 'inverter', 'generator', 'ev_charger', 'switchboard', 'air_con', 'other')),
  name text not null,
  make text,
  model text,
  serial_numbers text,
  quantity integer not null default 1,
  installed_at date,
  warranty_expires date,
  warranty_notes text,
  service_interval_months integer,
  last_serviced_at date,
  next_service_due date,
  notes text,
  status text not null default 'active' check (status in ('active', 'decommissioned')),
  reminders_paused boolean not null default false,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists customer_assets_client_idx on customer_assets (client_id);
create index if not exists customer_assets_project_idx on customer_assets (project_id);
create index if not exists customer_assets_service_idx on customer_assets (next_service_due) where status = 'active';

create table if not exists asset_reminder_log (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references customer_assets(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  kind text not null check (kind in ('service', 'warranty', 'campaign')),
  outcome text not null default 'sent' check (outcome in ('sent', 'skipped')),
  campaign_name text,
  subject text,
  sent_to text,
  sent_by uuid references profiles(id) on delete set null,
  sent_at timestamptz not null default now()
);
create index if not exists asset_reminder_log_asset_idx on asset_reminder_log (asset_id, sent_at desc);

alter table customer_assets enable row level security;
alter table asset_reminder_log enable row level security;
drop policy if exists "staff full access on customer_assets" on customer_assets;
create policy "staff full access on customer_assets" on customer_assets for all to authenticated using (true) with check (true);
drop policy if exists "staff full access on asset_reminder_log" on asset_reminder_log;
create policy "staff full access on asset_reminder_log" on asset_reminder_log for all to authenticated using (true) with check (true);
