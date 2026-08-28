-- Migration 037 — Minimum stock levels + real material cost per job
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Minimum quantities, for restock flagging -------------------------------

alter table materials add column if not exists minimum_quantity numeric not null default 0;

-- 2. Job material usage - the actual-cost equivalent of time_entries for
-- labour. Two sources: material drawn from existing stock (deducts
-- quantity_on_hand, costed at that moment), or material that arrived via
-- a job-specific PO and went straight to site (never touches stock at
-- all, since it was never general inventory to begin with).

create table if not exists job_material_usage (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  cost_centre_id uuid references cost_centres(id),
  material_id uuid references materials(id),
  quantity numeric not null,
  unit_cost numeric not null,
  source text not null check (source in ('from_stock', 'from_po')),
  po_line_item_id uuid references purchase_order_line_items(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table job_material_usage enable row level security;
drop policy if exists "Pricing roles manage job material usage" on job_material_usage;
create policy "Pricing roles manage job material usage" on job_material_usage
  for all using (is_pricing_role()) with check (is_pricing_role());

-- Real actual material cost for a stage - the materials-side counterpart
-- to get_stage_actual_labour_cost(), same "quoted vs actual" pattern.
create or replace function get_stage_actual_material_cost(p_cost_centre_id uuid)
returns numeric
language sql
security definer
as $$
  select coalesce(sum(quantity * unit_cost), 0)
  from job_material_usage
  where cost_centre_id = p_cost_centre_id;
$$;
