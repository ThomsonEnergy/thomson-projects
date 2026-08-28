-- Migration 008 — Phase 5 (Proposal templates, photo tagging, prebuilds)
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Proposal template on projects ----------------------------------------

alter table projects
  add column if not exists proposal_template text not null default 'new_build';

alter table projects
  add column if not exists estimate_disclaimer_text text
  default 'Estimate only — the final invoice is based on actual hours and materials used, not this figure. Accepting this estimate lets us schedule the work.';

alter table projects
  drop constraint if exists projects_proposal_template_check;

alter table projects
  add constraint projects_proposal_template_check
  check (proposal_template in ('new_build', 'solar', 'quick_estimate', 'time_and_materials'));

-- Photo categories (electrical/solar/general) don't need a schema change —
-- portfolio_photos is already a jsonb array of {url}, so a "category" key
-- just gets added to each object going forward. Existing untagged photos
-- are treated as 'general' by the app.

-- 2. Prebuild library --------------------------------------------------------

create table if not exists prebuilds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  internal_part_number text,
  client_description text,
  category text not null,
  subcategory text,
  created_at timestamptz not null default now()
);

create table if not exists prebuild_components (
  id uuid primary key default gen_random_uuid(),
  prebuild_id uuid not null references prebuilds(id) on delete cascade,
  item_type text not null check (item_type in ('labour', 'material')),
  description text not null,
  quantity numeric not null default 1,
  unit_cost numeric not null default 0,
  sort_order int not null default 0
);

-- Prebuilds are a quoting tool — same access as company_settings and
-- cost_centres pricing: Admin/Finance/Sales only, not Staff.

alter table prebuilds enable row level security;
drop policy if exists "Pricing roles manage prebuilds" on prebuilds;
create policy "Pricing roles manage prebuilds" on prebuilds
  for all using (is_pricing_role()) with check (is_pricing_role());

alter table prebuild_components enable row level security;
drop policy if exists "Pricing roles manage prebuild components" on prebuild_components;
create policy "Pricing roles manage prebuild components" on prebuild_components
  for all using (is_pricing_role()) with check (is_pricing_role());
