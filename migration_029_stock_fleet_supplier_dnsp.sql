-- Migration 029 — Stock, Fleet, Supplier Bills, DNSP reference
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Stock / Materials Database ---------------------------------------------
-- The long-planned Materials Database (spec #29) - a real starting
-- version: name, cost/sell price, category, supplier, quantity on hand.
-- Not yet wired into quoting/invoicing as a line-item source - that's a
-- bigger follow-up once this exists and has real data in it.

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  supplier text,
  cost_price numeric not null default 0,
  sell_price numeric not null default 0,
  quantity_on_hand numeric not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

alter table materials enable row level security;
drop policy if exists "Pricing roles manage materials" on materials;
create policy "Pricing roles manage materials" on materials
  for all using (is_pricing_role()) with check (is_pricing_role());
drop policy if exists "Everyone can view materials" on materials;
create policy "Everyone can view materials" on materials for select using (true);

-- 2. Fleet - vehicle details and maintenance --------------------------------

create table if not exists fleet_vehicles (
  id uuid primary key default gen_random_uuid(),
  rego text not null,
  make text,
  model text,
  year int,
  assigned_staff_id uuid references profiles(id),
  rego_expiry date,
  next_service_date date,
  odometer numeric,
  notes text,
  created_at timestamptz not null default now()
);

alter table fleet_vehicles enable row level security;
drop policy if exists "Everyone can view fleet" on fleet_vehicles;
create policy "Everyone can view fleet" on fleet_vehicles for select using (true);
drop policy if exists "Admin manages fleet" on fleet_vehicles;
create policy "Admin manages fleet" on fleet_vehicles
  for all using (is_admin()) with check (is_admin());

-- 3. Supplier bills - manual log for now ------------------------------------
-- A real, functional starting version - manual entry. The planned AI
-- extraction from a photo/PDF (spec #5) is a separate, later phase that
-- builds on top of this table rather than replacing it.

create table if not exists supplier_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  bill_number text,
  bill_date date,
  amount numeric not null default 0,
  po_reference text,
  project_id uuid references projects(id),
  paid boolean not null default false,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table supplier_bills enable row level security;
drop policy if exists "Pricing roles manage supplier bills" on supplier_bills;
create policy "Pricing roles manage supplier bills" on supplier_bills
  for all using (is_pricing_role()) with check (is_pricing_role());

-- 4. DNSP reference - not an integration (no real DNSP API exists to
-- connect to), but a genuinely useful reference/tracking page: which
-- DNSP applies to a given job, connection application status, and a
-- running note per job - until real portal access becomes available.

create table if not exists dnsp_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  dnsp_name text not null,
  application_reference text,
  status text not null default 'not_started',
  notes text,
  created_at timestamptz not null default now()
);

alter table dnsp_records enable row level security;
drop policy if exists "Pricing roles manage dnsp records" on dnsp_records;
create policy "Pricing roles manage dnsp records" on dnsp_records
  for all using (is_pricing_role()) with check (is_pricing_role());
