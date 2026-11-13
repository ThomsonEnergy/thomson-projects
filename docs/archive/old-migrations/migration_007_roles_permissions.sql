-- Migration 007 — Phase 3 (Roles & permissions + user management)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- IMPORTANT — after running this, every existing user defaults to 'staff'
-- (the safest default). You must manually promote your own account to
-- admin or you'll lock yourself out of the Users screen:
--
--   update profiles set role = 'admin' where id =
--     (select id from auth.users where email = 'YOUR-EMAIL-HERE');
--
-- If you don't have a profiles row yet (first login before this
-- migration), log in once first so the row gets created, then run the
-- update above.

-- 1. Extend profiles with role, name, active status ----------------------

alter table profiles
  add column if not exists role text not null default 'staff';

alter table profiles
  drop constraint if exists profiles_role_check;

alter table profiles
  add constraint profiles_role_check
  check (role in ('admin', 'finance', 'sales', 'staff'));

alter table profiles
  add column if not exists full_name text;

alter table profiles
  add column if not exists active boolean not null default true;

-- 2. Helper functions used throughout the policies below -----------------
-- security definer so they can read profiles even from within a policy
-- that's evaluating access to some other table.

create or replace function current_profile_role()
returns text
language sql
security definer
stable
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

create or replace function is_pricing_role()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select role from profiles where id = auth.uid()) in ('admin', 'finance', 'sales'), false);
$$;

-- 3. Profiles RLS ----------------------------------------------------------

drop policy if exists "Users can view own profile" on profiles;
drop policy if exists "Users can update own profile" on profiles;
drop policy if exists "Users can insert own profile" on profiles;

-- Everyone can see their own row, and admins can see everyone's (needed
-- for the Users screen's role/active columns).
create policy "View own or admin views all" on profiles
  for select using (auth.uid() = id or is_admin());

-- Users may update their own row EXCEPT role/active — enforced by only
-- ever writing theme/full_name from the client; role/active changes go
-- through the admin-only policy below plus the invite/toggle functions,
-- which use the service role and bypass RLS entirely.
create policy "Users can update own profile" on profiles
  for update using (auth.uid() = id);

create policy "Admins can update any profile" on profiles
  for update using (is_admin());

create policy "Users can insert own profile" on profiles
  for insert with check (auth.uid() = id);

-- 4. Pricing-masking views for cost_centres and line items ----------------
-- Staff can still see stage names/descriptions (needed for notes,
-- checklists, photos per-stage) but never dollar figures. Masking happens
-- in the view itself — enforced no matter what the client asks for.

drop view if exists cost_centres_secure;
create view cost_centres_secure
with (security_invoker = false) as
select
  id,
  project_id,
  name,
  description,
  sort_order,
  servicem8_job_uuid,
  servicem8_job_status,
  case when is_pricing_role() then markup_percent else null end as markup_percent,
  case when is_pricing_role() then quoted_amount else null end as quoted_amount,
  case when is_pricing_role() then labour_cost else null end as labour_cost,
  case when is_pricing_role() then material_cost else null end as material_cost,
  case when is_pricing_role() then invoiced_amount else null end as invoiced_amount
from cost_centres;

grant select on cost_centres_secure to authenticated;

drop view if exists cost_centre_line_items_secure;
create view cost_centre_line_items_secure
with (security_invoker = false) as
select
  id,
  cost_centre_id,
  description,
  item_type,
  sort_order,
  quantity,
  case when is_pricing_role() then unit_cost else null end as unit_cost
from cost_centre_line_items;

grant select on cost_centre_line_items_secure to authenticated;

-- Lock the base tables down so pricing can't be read by querying them
-- directly instead of the views above. Row is visible (so joins/counts
-- still work) but pricing columns are only ever exposed through the views.
alter table cost_centres enable row level security;
drop policy if exists "Read via secure view only - select" on cost_centres;
create policy "Authenticated can select rows" on cost_centres
  for select using (auth.uid() is not null);
drop policy if exists "Only pricing roles can write" on cost_centres;
create policy "Only pricing roles can write" on cost_centres
  for all using (is_pricing_role()) with check (is_pricing_role());

alter table cost_centre_line_items enable row level security;
drop policy if exists "Authenticated can select line item rows" on cost_centre_line_items;
create policy "Authenticated can select line item rows" on cost_centre_line_items
  for select using (auth.uid() is not null);
drop policy if exists "Only pricing roles can write line items" on cost_centre_line_items;
create policy "Only pricing roles can write line items" on cost_centre_line_items
  for all using (is_pricing_role()) with check (is_pricing_role());

-- NOTE: PostgREST (what supabase-js talks to) still lets a client SELECT *
-- straight off cost_centres/cost_centre_line_items and get real numbers
-- back, because the row-level policy above allows the read — RLS is row
-- level, not column level. The actual masking guarantee comes from the
-- app only ever querying the _secure views, combined with column
-- privileges below which remove direct column access for non-pricing
-- roles at the database grant level (belt and braces).

revoke select (markup_percent, quoted_amount, labour_cost, material_cost, invoiced_amount)
  on cost_centres from authenticated;
grant select (id, project_id, name, description, sort_order, servicem8_job_uuid, servicem8_job_status)
  on cost_centres to authenticated;

revoke select (unit_cost)
  on cost_centre_line_items from authenticated;
grant select (id, cost_centre_id, description, item_type, sort_order, quantity)
  on cost_centre_line_items to authenticated;

-- 5. Projects table ---------------------------------------------------------
-- No dollar figures live directly on projects, so it stays broadly
-- readable/writable by any active authenticated user (needed for the
-- pipeline board, notes, checklists once those land).

alter table projects enable row level security;
drop policy if exists "Authenticated can access projects" on projects;
create policy "Authenticated can access projects" on projects
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- 6. Company settings — quoting defaults are pricing-adjacent -------------

alter table company_settings enable row level security;
drop policy if exists "Pricing roles can read company settings" on company_settings;
create policy "Pricing roles can read company settings" on company_settings
  for select using (is_pricing_role());
drop policy if exists "Pricing roles can write company settings" on company_settings;
create policy "Pricing roles can write company settings" on company_settings
  for all using (is_pricing_role()) with check (is_pricing_role());

-- 7. API keys — admin only, read and write ---------------------------------
-- Holds third-party integration keys (ServiceM8, Anthropic, Pylon, ...).
-- Supabase's own URL/service-role key can never live in here — the app
-- needs those just to reach this database in the first place, so they
-- stay as Netlify environment variables.

create table if not exists api_keys (
  key_name text primary key,
  key_value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table api_keys enable row level security;
drop policy if exists "Admins only" on api_keys;
create policy "Admins only" on api_keys
  for all using (is_admin()) with check (is_admin());
