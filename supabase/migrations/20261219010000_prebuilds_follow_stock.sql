-- Item 105 part 3, prices that move by themselves (owner's "Yes build", 21 Nov 2026).
--
-- A prebuild component copied a Stock item's cost when it was picked and never heard about a
-- price change again. Now a material component can remember the Stock item it was picked from,
-- and its unit_cost follows that item's cost_price. Prebuilds then carry today's prices into new
-- quotes and into the website packages (20261219000000). Quotes already written do not change:
-- their lines are copies.
--
-- No money or stock moves, no payroll, no RLS change (the column sits under the table's existing
-- pricing-role policies). One data change: existing components are linked only where it is
-- certain, which changes no price today (see the backfill below).

alter table public.prebuild_components
  add column if not exists material_id uuid references public.materials(id) on delete set null;
create index if not exists prebuild_components_material on public.prebuild_components (material_id);

-- Backfill, the certain ones only: a material component whose description is exactly the name of
-- one Stock item AND whose cost still equals that item's cost today (an untouched copy). A
-- component whose cost differs may be a deliberate price, so it is left unlinked for a person to
-- link from the Prebuilds page. Sets the new column only; no unit_cost changes.
update public.prebuild_components c
   set material_id = m.id
  from public.materials m
 where c.item_type = 'material'
   and c.material_id is null
   and lower(btrim(c.description)) = lower(btrim(m.name))
   and c.unit_cost = m.cost_price
   and (select count(*) from public.materials m2 where lower(btrim(m2.name)) = lower(btrim(c.description))) = 1;

-- When a Stock item's cost changes (by hand, from a bill or from a price list), every prebuild
-- component linked to it takes the new cost.
create or replace function public.prebuild_components_follow_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update prebuild_components
     set unit_cost = new.cost_price
   where material_id = new.id and item_type = 'material' and unit_cost is distinct from new.cost_price;
  return null;
end;
$$;
revoke execute on function public.prebuild_components_follow_stock() from public, anon, authenticated;

drop trigger if exists trg_prebuild_components_follow_stock on public.materials;
create trigger trg_prebuild_components_follow_stock after update of cost_price on public.materials
  for each row when (new.cost_price is distinct from old.cost_price)
  execute function public.prebuild_components_follow_stock();
