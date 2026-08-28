-- Migration 031 — Supplier bill line items + PO link
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Recording each bill's actual line items (not just the bill total) is
-- what makes "has this supplier crept the price up on this part since
-- last time" answerable later - that overcharge-detection feature isn't
-- being built yet, but the price history it needs starts accumulating
-- from the first bill processed through this.

create table if not exists supplier_bill_line_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references supplier_bills(id) on delete cascade,
  material_id uuid references materials(id),
  description text not null,
  quantity numeric not null default 1,
  unit_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table supplier_bill_line_items enable row level security;
drop policy if exists "Pricing roles manage bill line items" on supplier_bill_line_items;
create policy "Pricing roles manage bill line items" on supplier_bill_line_items
  for all using (is_pricing_role()) with check (is_pricing_role());

alter table supplier_bills add column if not exists po_id uuid references purchase_orders(id);
