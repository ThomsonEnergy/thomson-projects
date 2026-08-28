-- Migration 038 — Stock locations (vehicles + Warehouse)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Stock quantity stops being one number per material and becomes a
-- breakdown across locations - the Warehouse/shed, plus any vehicle
-- flagged as holding stock. materials.quantity_on_hand is kept as the
-- always-correct TOTAL, auto-maintained by a trigger whenever a
-- location's quantity changes - so every existing feature that already
-- reads/writes quantity_on_hand keeps working unchanged, while new
-- features can work with the per-location breakdown directly.

-- 1. Vehicle identity + stock-holding flag ----------------------------------

alter table fleet_vehicles add column if not exists vehicle_name text;
alter table fleet_vehicles add column if not exists asset_number text;
alter table fleet_vehicles add column if not exists holds_stock boolean not null default false;

-- 2. Per-location stock ------------------------------------------------------
-- location_type = 'warehouse' always has vehicle_id null (there's only
-- ever one Warehouse/shed); location_type = 'vehicle' always has a
-- vehicle_id. The partial unique indexes below prevent duplicate rows
-- for the same material+location.

create table if not exists material_stock_by_location (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  location_type text not null check (location_type in ('warehouse', 'vehicle')),
  vehicle_id uuid references fleet_vehicles(id),
  quantity numeric not null default 0,
  updated_at timestamptz not null default now()
);

create unique index if not exists material_stock_by_location_warehouse_uq
  on material_stock_by_location (material_id)
  where location_type = 'warehouse';

create unique index if not exists material_stock_by_location_vehicle_uq
  on material_stock_by_location (material_id, vehicle_id)
  where location_type = 'vehicle';

alter table material_stock_by_location enable row level security;
drop policy if exists "Everyone can view stock locations" on material_stock_by_location;
create policy "Everyone can view stock locations" on material_stock_by_location for select using (true);
drop policy if exists "Everyone can manage stock locations" on material_stock_by_location;
create policy "Everyone can manage stock locations" on material_stock_by_location
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- 3. Keep materials.quantity_on_hand as an always-correct total -------------

create or replace function sync_material_quantity_on_hand()
returns trigger
language plpgsql
as $$
declare
  v_material_id uuid;
begin
  v_material_id := coalesce(new.material_id, old.material_id);
  update materials
  set quantity_on_hand = (
    select coalesce(sum(quantity), 0) from material_stock_by_location where material_id = v_material_id
  )
  where id = v_material_id;
  return null;
end;
$$;

drop trigger if exists trg_sync_material_quantity on material_stock_by_location;
create trigger trg_sync_material_quantity
  after insert or update or delete on material_stock_by_location
  for each row execute function sync_material_quantity_on_hand();

-- 4. Seed existing quantities into Warehouse ---------------------------------
-- Every material's current quantity_on_hand is assumed to physically be
-- in the shed right now, since nothing has been assigned to a vehicle
-- yet - this preserves existing totals exactly, nothing is lost.

insert into material_stock_by_location (material_id, location_type, quantity)
select id, 'warehouse', quantity_on_hand
from materials
where quantity_on_hand > 0
on conflict do nothing;
