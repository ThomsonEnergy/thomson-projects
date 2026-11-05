-- Stock kinds and cable drums (docs/IDEAS_BACKLOG.md item 53, spec A12, A11b, A10).
--
-- What this does:
--  1. materials.kind: part, cable or consumable, guessed from the name when nobody says (trigger
--     materials_kind_sync, word rules in _stock_kind_guess). Cable carries pack_qty (metres per drum,
--     100 when the name does not say) and pack_unit ('m'). is_consumable follows kind.
--  2. material_units: cable drums, one row each, where it is and how many metres are left. Stock counts
--     for cable stay in metres; _stock_adjust keeps the drums in step with the count
--     (_material_units_reconcile), and the drum-aware steps move the drum first.
--  3. Receiving a supplier PO line of cable makes one drum per unit ordered (_po_line_land); undo takes
--     full drums back (_po_line_take_back). Stock pulls take metres off one drum (po_create_stock_pull
--     with unit_id and left_after); undo puts them back on it (po_undo_receive). Drums move
--     (stock_transfer_unit), get counted (stock_stocktake per drum, material_unit_set) and are added by
--     hand (material_unit_add). material_set_kind changes an item's kind and makes drums from its count.
--  4. A PO line with no Stock item received to the Warehouse or a van is linked to the item with that
--     name, or added to Stock, so the count moves (_po_line_autolink). Before this it was silently
--     not counted.
--  5. A first price lands on a $0 item whoever bills it (material_supplier_price_set), and cable prices
--     are kept per metre: a bill line per drum is divided by the drum size (the line's unit, else its
--     quantity, says which); a price list line with no unit waits for a person.
--  6. Scanning a part at clock-out sets the count at that place (set_count) instead of adding to it.

-- ---------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------
alter table public.materials add column if not exists kind text;
alter table public.materials add column if not exists pack_qty numeric;
alter table public.materials add column if not exists pack_unit text;
alter table public.materials drop constraint if exists materials_kind_check;
alter table public.materials add constraint materials_kind_check check (kind is null or kind in ('part', 'cable', 'consumable'));
alter table public.supplier_bill_line_items add column if not exists unit text;
alter table public.purchase_order_line_items add column if not exists material_unit_id uuid;

-- ---------------------------------------------------------------------------------------------------
-- 2. The word rules: what kind of thing a name describes
-- ---------------------------------------------------------------------------------------------------
-- Returns {kind, pack_qty, pack_label, looks_tool}. kind is cable when a cable word sits with a drum,
-- coil, roll, reel or a length (100m); consumable when a pack size is written (bag of 100, 50pk) or it
-- is a known small fitting; else part. looks_tool is a hint only: tools live in the Tools register.
create or replace function public._stock_kind_guess(p_name text, p_category text default null)
returns jsonb language plpgsql immutable as $$
declare
  t text := lower(coalesce(p_name, '') || ' ' || coalesce(p_category, ''));
  v_kind text := 'part';
  v_pack numeric;
  v_label text;
  v_len text[];
  v_pk text[];
  v_cable_word boolean;
  v_length boolean;
begin
  v_cable_word := t ~ '\m(cable|cables|tps|twin and earth|twin & earth|t&e|t\+e|circular|building wire|earth wire|flex|flexible cord|cat ?6a?|cat ?5e?|data|coax|coaxial|rg6|solar dc|dc cable|pv wire|welding|xlpe|sdi|single core|orange circ)\M'
    or lower(coalesce(p_category, '')) ~ '\m(cable|cables|cabling)\M';
  v_length := t ~ '\m(drum|drums|coil|coils|reel|reels|roll|rolls)\M' or t ~ '\m\d{2,4} ?(m|mtr|mtrs|metre|metres|meter|meters)\M';
  if v_cable_word and v_length then
    v_kind := 'cable';
    v_len := regexp_match(t, '\m(\d{2,4}) ?(m|mtr|mtrs|metre|metres|meter|meters)\M');
    if v_len is not null and v_len[1]::numeric >= 20 then v_pack := v_len[1]::numeric; end if;
  elsif t ~ '\m(bag|bags|box|boxes|pack|packs|packet|pkt|pk|tub|jar|carton|ctn|sleeve)( of)? ?\d{1,4}\M'
     or t ~ '\m\d{1,4} ?(pk|pcs|pce|pack|per bag|per box)\M'
     or t ~ '\m(zip tie|zip ties|cable tie|cable ties|saddle|saddles|wall plug|wall plugs|gyprock screw|tek screw|screws|nails|anchors|silicone|sealant|tape|glands?|wago|bp connector|bp connectors|scotchlok|lugs?|crimp lugs?)\M' then
    v_kind := 'consumable';
    v_pk := regexp_match(t, '\m((bag|box|pack|packet|pkt|pk|tub|jar|carton|ctn|sleeve)( of)? ?\d{1,4})\M');
    if v_pk is null then v_pk := regexp_match(t, '\m(\d{1,4} ?(pk|pcs|pce|pack))\M'); end if;
    if v_pk is not null then v_label := v_pk[1]; end if;
  end if;
  return jsonb_build_object('kind', v_kind, 'pack_qty', v_pack, 'pack_label', v_label,
    'looks_tool', t ~ '\m(drill|drills|driver|impact|grinder|saw|saws|multimeter|clamp meter|tester|testers|crimper|crimpers|crimping tool|stripper|strippers|ladder|ladders|torch|laser|vacuum|blower|heat gun|rotary hammer|charger|milwaukee|dewalt|makita|bosch|festool|hilti|fluke|knipex|klein|kincrome|sidchrome|megger)\M');
end;
$$;
revoke all on function public._stock_kind_guess(text, text) from public, anon;
grant execute on function public._stock_kind_guess(text, text) to authenticated;

-- kind, pack size and is_consumable kept in step on every insert and update: a row that arrives with
-- no kind takes the guess (or consumable when the old tick box was ticked); cable always has a drum
-- size (100 when the name does not say); is_consumable is simply kind = consumable.
create or replace function public.materials_kind_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  g jsonb;
begin
  if tg_op = 'INSERT' then
    if new.kind is null then
      if coalesce(new.is_consumable, false) then
        new.kind := 'consumable';
      else
        g := _stock_kind_guess(new.name, new.category);
        new.kind := g->>'kind';
        if new.kind = 'cable' and new.pack_qty is null then new.pack_qty := (g->>'pack_qty')::numeric; end if;
        if new.kind = 'consumable' and new.pack_label is null then new.pack_label := g->>'pack_label'; end if;
      end if;
    end if;
  elsif new.kind is not distinct from old.kind and new.is_consumable is distinct from old.is_consumable then
    -- the old tick box still works: it moves the kind
    new.kind := case when new.is_consumable then 'consumable' when new.kind = 'consumable' then 'part' else new.kind end;
  end if;
  if new.kind = 'cable' then
    if coalesce(new.pack_qty, 0) <= 0 then new.pack_qty := 100; end if;
    new.pack_unit := coalesce(new.pack_unit, 'm');
  end if;
  new.is_consumable := (new.kind = 'consumable');
  return new;
end;
$$;
revoke all on function public.materials_kind_sync() from public, anon, authenticated;
drop trigger if exists trg_materials_kind_sync on public.materials;
create trigger trg_materials_kind_sync before insert or update on public.materials
  for each row execute function public.materials_kind_sync();

-- ---------------------------------------------------------------------------------------------------
-- 3. Drums
-- ---------------------------------------------------------------------------------------------------
create table if not exists public.material_units (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  location_type text not null check (location_type in ('warehouse', 'vehicle')),
  vehicle_id uuid references public.fleet_vehicles(id) on delete cascade,
  qty_left numeric not null check (qty_left >= 0),
  pack_qty numeric,
  po_line_item_id uuid references public.purchase_order_line_items(id) on delete set null,
  label text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists material_units_material_idx on public.material_units(material_id);
create index if not exists material_units_vehicle_idx on public.material_units(vehicle_id);
create index if not exists material_units_po_line_idx on public.material_units(po_line_item_id);
create index if not exists material_units_created_by_idx on public.material_units(created_by);
alter table public.material_units enable row level security;
drop policy if exists "Everyone can view drums" on public.material_units;
create policy "Everyone can view drums" on public.material_units for select to authenticated using (true);
-- writes only through the functions below (no insert, update or delete policy)

alter table public.purchase_order_line_items drop constraint if exists purchase_order_line_items_material_unit_id_fkey;
alter table public.purchase_order_line_items add constraint purchase_order_line_items_material_unit_id_fkey
  foreign key (material_unit_id) references public.material_units(id) on delete set null;
create index if not exists purchase_order_line_items_material_unit_idx on public.purchase_order_line_items(material_unit_id);

create or replace function public._is_drum_item(p_material uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from materials where id = p_material and kind = 'cable' and coalesce(pack_qty, 0) > 0);
$$;
revoke all on function public._is_drum_item(uuid) from public, anon, authenticated;

create or replace function public._drum_label(p_material uuid, p_left numeric)
returns text language sql stable set search_path = public as $$
  select format('%s (%sm)', (select name from materials where id = p_material), _po_qty(p_left));
$$;
revoke all on function public._drum_label(uuid, numeric) from public, anon, authenticated;

-- Keeps a cable item's drums adding up to its count at one place. Called at the end of _stock_adjust,
-- so a count change that does not know which drum (a stocktake typed as one number, a variation) still
-- leaves the drums right: extra metres become full drums then one part drum, missing metres come off
-- the part drums first. A step that moves a known drum updates the drum before it adjusts the count,
-- so this finds nothing to do.
create or replace function public._material_units_reconcile(p_material uuid, p_loc text, p_vehicle uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_count numeric;
  v_units numeric;
  v_diff numeric;
  v_take numeric;
  u record;
begin
  select * into m from materials where id = p_material;
  if not found or m.kind <> 'cable' or coalesce(m.pack_qty, 0) <= 0 then return; end if;
  select coalesce(sum(quantity), 0) into v_count from material_stock_by_location
    where material_id = m.id and location_type = p_loc and (p_loc = 'warehouse' or vehicle_id = p_vehicle);
  select coalesce(sum(qty_left), 0) into v_units from material_units
    where material_id = m.id and location_type = p_loc and (p_loc = 'warehouse' or vehicle_id = p_vehicle);
  v_diff := v_count - v_units;
  if v_diff > 0.005 then
    while v_diff >= m.pack_qty loop
      insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, created_by)
      values (m.id, p_loc, case when p_loc = 'vehicle' then p_vehicle end, m.pack_qty, m.pack_qty, auth.uid());
      v_diff := v_diff - m.pack_qty;
    end loop;
    if v_diff > 0.005 then
      insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, label, created_by)
      values (m.id, p_loc, case when p_loc = 'vehicle' then p_vehicle end, round(v_diff, 2), m.pack_qty, 'Part drum', auth.uid());
    end if;
    perform _po_log('material', m.id, 'drums_adjusted', format('Drums at %s brought up to the count of %sm', _po_place_label(p_loc, null, p_vehicle), _po_qty(v_count)));
  elsif v_diff < -0.005 then
    v_take := -v_diff;
    for u in select id, qty_left from material_units
        where material_id = m.id and location_type = p_loc and (p_loc = 'warehouse' or vehicle_id = p_vehicle)
        order by qty_left asc, created_at asc loop
      exit when v_take <= 0.005;
      if u.qty_left <= v_take then
        delete from material_units where id = u.id;
        v_take := v_take - u.qty_left;
      else
        update material_units set qty_left = round(qty_left - v_take, 2), updated_at = now() where id = u.id;
        v_take := 0;
      end if;
    end loop;
    perform _po_log('material', m.id, 'drums_adjusted', format('Drums at %s brought down to the count of %sm', _po_place_label(p_loc, null, p_vehicle), _po_qty(v_count)));
  end if;
end;
$$;
revoke all on function public._material_units_reconcile(uuid, text, uuid) from public, anon, authenticated;

-- Same as migration 20261025000000 plus the drum reconcile at the end (item 53).
create or replace function public._stock_adjust(p_material uuid, p_loc text, p_vehicle uuid, p_delta numeric, p_allow_short boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_row material_stock_by_location;
  v_new numeric;
begin
  if p_material is null or p_delta = 0 then return null; end if;
  select * into v_row from material_stock_by_location
    where material_id = p_material and location_type = p_loc
      and (p_loc = 'warehouse' or vehicle_id = p_vehicle)
    for update;
  v_new := coalesce(v_row.quantity, 0) + p_delta;
  if v_new < 0 then
    if not p_allow_short then
      raise exception 'Only % of % in %. Fix the stock count first if that is wrong.',
        _po_qty(coalesce(v_row.quantity, 0)), (select name from materials where id = p_material), _po_place_label(p_loc, null, p_vehicle);
    end if;
    v_new := 0;
  end if;
  if v_row.id is null then
    insert into material_stock_by_location (material_id, location_type, vehicle_id, quantity)
    values (p_material, p_loc, case when p_loc = 'vehicle' then p_vehicle end, v_new);
  else
    update material_stock_by_location set quantity = v_new, updated_at = now() where id = v_row.id;
  end if;
  perform _material_units_reconcile(p_material, p_loc, p_vehicle);
  return v_new;
end;
$$;
revoke all on function public._stock_adjust(uuid, text, uuid, numeric, boolean) from public, anon, authenticated;

-- Set what is left on a drum (a stocktake, a tap on the van page or the Stock page). 0 finishes it.
create or replace function public.material_unit_set(p_unit_id uuid, p_left numeric, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  u material_units;
  v_place text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_left is null or p_left < 0 then raise exception 'Metres left cannot be below 0.'; end if;
  select * into u from material_units where id = p_unit_id for update;
  if not found then raise exception 'That drum is no longer in Stock.'; end if;
  if abs(u.qty_left - p_left) < 0.005 then return; end if;
  v_place := _po_place_label(u.location_type, null, u.vehicle_id);
  if p_left <= 0.005 then
    delete from material_units where id = u.id;
  else
    update material_units set qty_left = round(p_left, 2), updated_at = now() where id = u.id;
  end if;
  perform _stock_adjust(u.material_id, u.location_type, u.vehicle_id, p_left - u.qty_left, true);
  perform _po_log('material', u.material_id, 'stock_count_corrected', format('Drum at %s set to %sm (app had %sm)%s%s', v_place, _po_qty(p_left), _po_qty(u.qty_left),
    case when p_left <= 0.005 then ', finished' else '' end, coalesce(': ' || nullif(trim(p_reason), ''), '')));
end;
$$;
revoke all on function public.material_unit_set(uuid, numeric, text) from public, anon;
grant execute on function public.material_unit_set(uuid, numeric, text) to authenticated;

-- A drum the app did not know about (found on a stocktake, brought in without a PO).
create or replace function public.material_unit_add(p_material_id uuid, p_loc text, p_vehicle_id uuid, p_metres numeric, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  if p_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_vehicle_id and holds_stock) then raise exception 'Pick the vehicle.'; end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  if not _is_drum_item(m.id) then raise exception '% is not counted by the drum.', m.name; end if;
  if p_metres is null or p_metres <= 0 then raise exception 'How many metres are on the drum?'; end if;
  insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, created_by)
  values (m.id, p_loc, case when p_loc = 'vehicle' then p_vehicle_id end, round(p_metres, 2), m.pack_qty, auth.uid())
  returning id into v_id;
  perform _stock_adjust(m.id, p_loc, p_vehicle_id, p_metres);
  perform _po_log('material', m.id, 'stock_count_corrected', format('Drum of %sm added at %s%s', _po_qty(p_metres), _po_place_label(p_loc, null, p_vehicle_id), coalesce(': ' || nullif(trim(p_reason), ''), '')));
  return v_id;
end;
$$;
revoke all on function public.material_unit_add(uuid, text, uuid, numeric, text) from public, anon;
grant execute on function public.material_unit_add(uuid, text, uuid, numeric, text) to authenticated;

-- Move one drum between the Warehouse and a van (no PO).
create or replace function public.stock_transfer_unit(p_unit_id uuid, p_to_loc text, p_to_vehicle uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  u material_units;
  v_from text;
  v_to text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_to_loc not in ('warehouse', 'vehicle') then raise exception 'Pick where it goes.'; end if;
  if p_to_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_to_vehicle and holds_stock) then raise exception 'Pick the vehicle it goes to.'; end if;
  select * into u from material_units where id = p_unit_id for update;
  if not found then raise exception 'That drum is no longer in Stock.'; end if;
  if u.location_type = p_to_loc and (p_to_loc = 'warehouse' or u.vehicle_id = p_to_vehicle) then raise exception 'That drum is already there.'; end if;
  v_from := _po_place_label(u.location_type, null, u.vehicle_id);
  v_to := _po_place_label(p_to_loc, null, p_to_vehicle);
  update material_units set location_type = p_to_loc, vehicle_id = case when p_to_loc = 'vehicle' then p_to_vehicle end, updated_at = now() where id = u.id;
  perform _stock_adjust(u.material_id, u.location_type, u.vehicle_id, -u.qty_left, true);
  perform _stock_adjust(u.material_id, p_to_loc, p_to_vehicle, u.qty_left);
  perform _po_log('material', u.material_id, 'stock_moved', format('Drum (%sm) moved from %s to %s', _po_qty(u.qty_left), v_from, v_to));
end;
$$;
revoke all on function public.stock_transfer_unit(uuid, text, uuid) from public, anon;
grant execute on function public.stock_transfer_unit(uuid, text, uuid) to authenticated;

-- Change an item's kind (Stock edit panel, pricing roles). Becoming cable turns every count into drums;
-- no longer cable drops the drums (the counts stay).
create or replace function public.material_set_kind(p_material_id uuid, p_kind text, p_pack_qty numeric default null, p_pack_label text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  m materials;
  r record;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can change what kind of item it is.'; end if;
  if p_kind not in ('part', 'cable', 'consumable') then raise exception 'Part, cable or consumable?'; end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  if p_kind = 'cable' and coalesce(p_pack_qty, m.pack_qty, 0) <= 0 then raise exception 'How many metres on a full drum?'; end if;
  update materials set kind = p_kind,
    pack_qty = case when p_kind = 'cable' then coalesce(p_pack_qty, pack_qty) else null end,
    pack_unit = case when p_kind = 'cable' then 'm' else null end,
    pack_label = case when p_kind = 'consumable' then coalesce(nullif(trim(coalesce(p_pack_label, '')), ''), pack_label) else null end
    where id = m.id;
  if p_kind = 'cable' then
    if m.kind = 'cable' and m.pack_qty is distinct from coalesce(p_pack_qty, m.pack_qty) then
      update material_units set pack_qty = coalesce(p_pack_qty, m.pack_qty) where material_id = m.id;
    end if;
    for r in select location_type, vehicle_id from material_stock_by_location where material_id = m.id and quantity > 0 loop
      perform _material_units_reconcile(m.id, r.location_type, r.vehicle_id);
    end loop;
    if m.kind is distinct from 'cable' then perform _po_log('material', m.id, 'updated', format('Now counted by the drum (%sm): the count is in metres and shown drum by drum', _po_qty(coalesce(p_pack_qty, m.pack_qty)))); end if;
  else
    if m.kind = 'cable' then
      delete from material_units where material_id = m.id;
      perform _po_log('material', m.id, 'updated', format('No longer counted by the drum: now %s', case when p_kind = 'consumable' then 'a consumable' else 'a part' end));
    end if;
  end if;
end;
$$;
revoke all on function public.material_set_kind(uuid, text, numeric, text) from public, anon;
grant execute on function public.material_set_kind(uuid, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 4. Receiving: unlinked lines get counted, cable lands as drums
-- ---------------------------------------------------------------------------------------------------
-- A PO line with no Stock item, received to the Warehouse or a van: the Stock item with exactly that
-- name, else a new one from the line (kind guessed, cost per metre for cable, needs a price at $0).
create or replace function public._po_line_autolink(p_line uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_mat uuid;
  v_markup numeric;
  g jsonb;
  v_cost numeric;
  v_pack numeric;
begin
  select * into li from purchase_order_line_items where id = p_line;
  if li.material_id is not null then return li.material_id; end if;
  select * into po from purchase_orders where id = li.po_id;
  select id into v_mat from materials where lower(trim(name)) = lower(trim(li.description)) order by created_at limit 1;
  if v_mat is null then
    select coalesce(default_markup_percent, 45) into v_markup from company_settings where id = 1;
    g := _stock_kind_guess(li.description, null);
    v_cost := coalesce(li.unit_cost, 0);
    if g->>'kind' = 'cable' then
      v_pack := coalesce((g->>'pack_qty')::numeric, 100);
      v_cost := round(v_cost / v_pack, 4);
    end if;
    insert into materials (name, supplier_id, supplier, cost_price, sell_price, needs_price, kind, pack_qty, pack_label, created_by)
    values (trim(li.description), po.supplier_id, po.supplier_name, v_cost, round(v_cost * (1 + v_markup / 100), 2), v_cost <= 0,
            g->>'kind', v_pack, g->>'pack_label', auth.uid())
    returning id into v_mat;
    perform _po_log('material', v_mat, 'created', format('Added to Stock when PO %s was received%s', po.po_number, case when v_cost <= 0 then ', needs a price' else '' end));
    perform _po_log('purchase_order', po.id, 'added_to_stock', format('%s added to Stock so the count moves', trim(li.description)));
  else
    perform _po_log('purchase_order', po.id, 'linked_to_stock', format('%s linked to the Stock item of that name', trim(li.description)));
  end if;
  update purchase_order_line_items set material_id = v_mat where id = li.id;
  return v_mat;
end;
$$;
revoke all on function public._po_line_autolink(uuid) from public, anon, authenticated;

-- Same as migration 20261111000000 plus: an unlinked line to the Warehouse or a van is linked or added
-- to Stock first; a supplier PO line of cable lands as drums and metres (item 53).
create or replace function public._po_line_land(p_line uuid, p_dest text, p_job uuid, p_vehicle uuid, p_cost_centre uuid, p_first_receive boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  m materials;
  v_kind text;
  v_bill uuid;
  v_drums numeric;
  v_part numeric;
  i integer;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
  select * into po from purchase_orders where id = li.po_id;
  if p_dest not in ('job', 'warehouse', 'vehicle', 'tools') then raise exception 'Pick where it goes.'; end if;
  if p_dest = 'job' and p_job is null then raise exception 'Pick the job.'; end if;
  if p_dest = 'vehicle' and p_vehicle is null then raise exception 'Pick the vehicle.'; end if;
  if p_dest = 'tools' and not (li.is_tool or po.po_kind = 'tools') then raise exception '% is not marked as a tool. Mark it first.', li.description; end if;
  if p_dest <> 'tools' and (li.is_tool or po.po_kind = 'tools') then raise exception '% is a tool: receive it to Tools (Warehouse or a vehicle).', li.description; end if;

  if li.material_id is null and p_dest in ('warehouse', 'vehicle') then
    li.material_id := _po_line_autolink(li.id);
  end if;

  if p_first_receive then
    if po.stock_source is not null then
      perform _stock_adjust(li.material_id, po.stock_source, po.stock_source_vehicle_id, -li.quantity);
    elsif po.vehicle_id is not null and po.supplier_id is null then
      perform _stock_adjust(li.material_id, 'warehouse', null, -li.quantity);
    end if;
  end if;

  if p_dest = 'job' then
    insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, po_line_item_id, created_by)
    values (p_job, p_cost_centre, li.material_id, li.quantity, li.unit_cost,
            case when po.stock_source is not null then 'from_stock' else 'from_po' end, li.id, auth.uid());
  elsif p_dest = 'tools' then
    v_kind := coalesce(li.tool_kind, 'tool');
    select id into v_bill from supplier_bills where po_id = po.id order by created_at limit 1;
    if v_kind = 'perishable' then
      insert into tools (name, kind, quantity, purchase_date, cost, supplier_id, supplier_name, bill_id, po_line_item_id, bought_by, location_type, vehicle_id, created_by)
      values (li.description, 'perishable', li.quantity, sydney_today(), li.unit_cost, po.supplier_id, po.supplier_name, v_bill, li.id, coalesce(li.added_by, auth.uid()), case when p_vehicle is not null then 'vehicle' else 'warehouse' end, p_vehicle, auth.uid());
    else
      for i in 1..greatest(1, ceil(li.quantity)::integer) loop
        insert into tools (name, kind, quantity, purchase_date, cost, supplier_id, supplier_name, bill_id, po_line_item_id, bought_by, location_type, vehicle_id, created_by)
        values (li.description, 'tool', 1, sydney_today(), li.unit_cost, po.supplier_id, po.supplier_name, v_bill, li.id, coalesce(li.added_by, auth.uid()), case when p_vehicle is not null then 'vehicle' else 'warehouse' end, p_vehicle, auth.uid());
      end loop;
    end if;
  elsif po.stock_source is null and _is_drum_item(li.material_id) then
    -- a supplier PO line of cable: one drum per unit ordered, the count in metres
    select * into m from materials where id = li.material_id;
    v_drums := floor(li.quantity);
    v_part := round((li.quantity - v_drums) * m.pack_qty, 2);
    for i in 1..v_drums::integer loop
      insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, po_line_item_id, created_by)
      values (m.id, p_dest, case when p_dest = 'vehicle' then p_vehicle end, m.pack_qty, m.pack_qty, li.id, auth.uid());
    end loop;
    if v_part > 0.005 then
      insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, po_line_item_id, label, created_by)
      values (m.id, p_dest, case when p_dest = 'vehicle' then p_vehicle end, v_part, m.pack_qty, li.id, 'Part drum', auth.uid());
    end if;
    perform _stock_adjust(li.material_id, p_dest, p_vehicle, li.quantity * m.pack_qty);
  else
    perform _stock_adjust(li.material_id, p_dest, p_vehicle, li.quantity);
  end if;

  update purchase_order_line_items set
    received = true, destination_type = p_dest,
    destination_job_id = case when p_dest = 'job' then p_job end,
    destination_vehicle_id = case when p_dest in ('vehicle', 'tools') then p_vehicle end,
    received_by = auth.uid(), received_at = now(),
    is_backordered = false, backorder_eta = null
  where id = li.id;
end;
$$;
revoke all on function public._po_line_land(uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- Same as migration 20261124160000 plus: a supplier PO line of cable taken back from the Warehouse or
-- a van takes its full drums back (a drum that has been used stops it) (item 53).
create or replace function public._po_line_take_back(p_line uuid, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  m materials;
  u record;
  v_left numeric := p_qty;
  v_need integer;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
  select * into po from purchase_orders where id = li.po_id;
  if li.destination_type = 'job' then
    if exists (select 1 from invoice_line_items il join job_material_usage jm on jm.id = il.job_material_usage_id where jm.po_line_item_id = li.id) then
      raise exception '% has already been invoiced to the client on %, so it cannot come off that job.', li.description, _po_job_ref(li.destination_job_id);
    end if;
    for u in select id, quantity from job_material_usage where po_line_item_id = li.id order by created_at desc loop
      exit when v_left <= 0;
      if u.quantity <= v_left then
        delete from job_material_usage where id = u.id;
        v_left := v_left - u.quantity;
      else
        update job_material_usage set quantity = quantity - v_left where id = u.id;
        v_left := 0;
      end if;
    end loop;
    if v_left > 0 then
      raise exception 'Only % of % is still costed to %, so % cannot come off it. Check the job''s materials first.',
        _po_qty(p_qty - v_left), li.description, _po_job_ref(li.destination_job_id), _po_qty(p_qty);
    end if;
  elsif li.destination_type in ('warehouse', 'vehicle') then
    if po.stock_source is null and _is_drum_item(li.material_id) then
      select * into m from materials where id = li.material_id;
      v_need := ceil(p_qty)::integer;
      for u in select id from material_units
          where po_line_item_id = li.id and location_type = li.destination_type
            and (li.destination_type = 'warehouse' or vehicle_id = li.destination_vehicle_id)
            and qty_left >= pack_qty - 0.005
          order by created_at desc loop
        exit when v_need <= 0;
        delete from material_units where id = u.id;
        v_need := v_need - 1;
      end loop;
      if v_need > 0 then
        raise exception 'Only % full drum(s) of % from this line are still at %. Fix the drums on the Stock page first.',
          ceil(p_qty)::integer - v_need, m.name, _po_place_label(li.destination_type, null, li.destination_vehicle_id);
      end if;
      perform _stock_adjust(li.material_id, li.destination_type, li.destination_vehicle_id, -p_qty * m.pack_qty, true);
    else
      perform _stock_adjust(li.material_id, li.destination_type, li.destination_vehicle_id, -p_qty);
    end if;
  elsif li.destination_type = 'tools' then
    for u in select id, quantity from tools where po_line_item_id = li.id and status = 'in_use' order by created_at desc loop
      exit when v_left <= 0;
      if u.quantity <= v_left then
        delete from tools where id = u.id;
        v_left := v_left - u.quantity;
      else
        update tools set quantity = quantity - v_left, updated_at = now() where id = u.id;
        v_left := 0;
      end if;
    end loop;
    if v_left > 0 and exists (select 1 from tools where po_line_item_id = li.id and status <> 'in_use') then
      raise exception '% is already marked broken, lost or sold in the Tools register, so it cannot be un-received.', li.description;
    end if;
  end if;
end;
$$;
revoke all on function public._po_line_take_back(uuid, numeric) from public, anon, authenticated;

-- Same as migration 20261027000000 plus: the new item's kind is guessed (trigger), cable keeps its
-- price per metre and lands as drums when the line was already received to the Warehouse or a van.
create or replace function public.po_line_add_to_stock(p_line_id uuid, p_name text, p_category text, p_supplier_id uuid,
  p_cost numeric, p_sell numeric, p_minimum numeric default 0)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  m materials;
  v_mat uuid;
  i integer;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can add Stock items.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  if li.material_id is not null then raise exception 'That line is already a Stock item.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Give the Stock item a name.'; end if;
  select * into po from purchase_orders where id = li.po_id;

  insert into materials (name, category, supplier_id, supplier, cost_price, sell_price, minimum_quantity)
  values (trim(p_name), nullif(trim(coalesce(p_category, '')), ''), p_supplier_id,
          (select name from suppliers where id = p_supplier_id),
          coalesce(p_cost, 0), coalesce(p_sell, 0), coalesce(p_minimum, 0))
  returning * into m;
  v_mat := m.id;
  if m.kind = 'cable' and coalesce(m.pack_qty, 0) > 0 then
    -- the PO line is per drum; the item is priced and counted per metre
    update materials set cost_price = round(coalesce(p_cost, 0) / m.pack_qty, 4), sell_price = round(coalesce(p_sell, 0) / m.pack_qty, 4) where id = v_mat;
  end if;

  update purchase_order_line_items set material_id = v_mat where id = li.id;
  if li.received and li.destination_type in ('warehouse', 'vehicle') then
    if m.kind = 'cable' and coalesce(m.pack_qty, 0) > 0 then
      for i in 1..greatest(1, ceil(li.quantity)::integer) loop
        insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, po_line_item_id, created_by)
        values (v_mat, li.destination_type, li.destination_vehicle_id, m.pack_qty, m.pack_qty, li.id, auth.uid());
      end loop;
      perform _stock_adjust(v_mat, li.destination_type, li.destination_vehicle_id, ceil(li.quantity) * m.pack_qty);
    else
      perform _stock_adjust(v_mat, li.destination_type, li.destination_vehicle_id, li.quantity);
    end if;
  elsif li.received and li.destination_type = 'job' then
    update job_material_usage set material_id = v_mat where po_line_item_id = li.id and material_id is null;
  end if;

  perform _po_log('purchase_order', po.id, 'added_to_stock', format('%s added to Stock from PO %s', trim(p_name), po.po_number));
  perform _po_log('material', v_mat, 'created', format('Added to Stock from PO %s%s', po.po_number,
    case when li.received and li.destination_type in ('warehouse', 'vehicle')
      then format(' (%s already received to %s)', _po_qty(li.quantity), _po_place_label(li.destination_type, null, li.destination_vehicle_id)) else '' end));
  return v_mat;
end;
$$;
revoke all on function public.po_line_add_to_stock(uuid, text, text, uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.po_line_add_to_stock(uuid, text, text, uuid, numeric, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 5. Stock pulls off a drum, and undo back onto it
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261110000000 plus cable lines (item 53): { material_id, quantity (metres used),
-- unit_id (the drum, or null for "a full one"), left_after (metres left on that drum) }. The drum's
-- reading is what was typed; the count moves by the difference; a drum at 0 is finished; the line
-- remembers the drum so undo puts the metres back on it.
create or replace function public.po_create_stock_pull(p_project_id uuid, p_cost_centre_id uuid, p_source text, p_vehicle_id uuid, p_lines jsonb, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_po uuid;
  v_num text;
  v_place text;
  v_line jsonb;
  m materials;
  u material_units;
  v_qty numeric;
  v_have numeric;
  v_left numeric;
  v_li uuid;
  v_unit uuid;
  v_new_name text;
  v_summary text[] := '{}';
  v_needs_price text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  if p_source not in ('warehouse', 'vehicle') then raise exception 'Pick where the gear comes from.'; end if;
  if p_source = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_vehicle_id and holds_stock) then
    raise exception 'Pick the vehicle.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then raise exception 'Job not found.'; end if;
  if p_cost_centre_id is not null and not exists (select 1 from cost_centres where id = p_cost_centre_id and project_id = p_project_id) then
    raise exception 'That stage is not on this job.';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item.'; end if;
  v_place := _po_place_label(p_source, null, p_vehicle_id);

  update company_settings set next_po_number = next_po_number + 1 where id = 1
    returning coalesce(nullif(po_number_prefix, ''), 'PO') || (next_po_number - 1) into v_num;

  insert into purchase_orders (project_id, cost_centre_id, supplier_id, supplier_name, po_number, description,
      po_type, locked, status, amount, received, received_by, received_at, closed_at, closed_by,
      approved_for_payment, approved_by, approved_at, stock_source, stock_source_vehicle_id)
  values (p_project_id, p_cost_centre_id, null, v_place, v_num, coalesce(nullif(trim(p_description), ''), 'Stock pulled from ' || v_place),
      'fixed', true, 'closed', 0, true, auth.uid(), now(), now(), auth.uid(),
      true, auth.uid(), now(), p_source, case when p_source = 'vehicle' then p_vehicle_id end)
  returning id into v_po;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_new_name := nullif(trim(coalesce(v_line->>'new_name', '')), '');
    v_unit := null;
    if nullif(v_line->>'material_id', '') is not null then
      select * into m from materials where id = (v_line->>'material_id')::uuid;
      if not found then raise exception 'Pick each item from Stock.'; end if;
    elsif v_new_name is not null then
      -- a part that is not in Stock yet: made now at $0 and flagged for a price
      select * into m from materials where lower(name) = lower(v_new_name) limit 1;
      if not found then
        insert into materials (name, cost_price, sell_price, needs_price, created_by)
        values (v_new_name, 0, 0, true, auth.uid()) returning * into m;
        perform _po_log('material', m.id, 'created', format('Added to Stock from My Day on %s, needs a price', _po_job_ref(p_project_id)));
        v_needs_price := v_needs_price || m.name;
      end if;
    else
      raise exception 'Pick each item from Stock, or add it with a name.';
    end if;
    v_qty := (v_line->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Enter how many % you are taking.', m.name; end if;

    if _is_drum_item(m.id) then
      -- cable: metres off one drum
      perform _material_units_reconcile(m.id, p_source, p_vehicle_id);
      v_left := nullif(v_line->>'left_after', '')::numeric;
      if v_left is null or v_left < 0 then raise exception 'Say how many metres are left on the drum of %.', m.name; end if;
      if nullif(v_line->>'unit_id', '') is not null then
        select * into u from material_units where id = (v_line->>'unit_id')::uuid and material_id = m.id
          and location_type = p_source and (p_source = 'warehouse' or vehicle_id = p_vehicle_id);
        if not found then raise exception 'That drum of % is no longer at %. Pick again.', m.name, v_place; end if;
      else
        -- a full drum if there is one, else the fullest
        select * into u from material_units where material_id = m.id
          and location_type = p_source and (p_source = 'warehouse' or vehicle_id = p_vehicle_id)
          order by (qty_left >= pack_qty - 0.005) desc, qty_left desc, created_at limit 1;
        if not found then
          -- the app has no drum here but the person is holding one
          insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, created_by)
          values (m.id, p_source, case when p_source = 'vehicle' then p_vehicle_id end, m.pack_qty, m.pack_qty, auth.uid())
          returning * into u;
          perform _stock_adjust(m.id, p_source, p_vehicle_id, m.pack_qty);
          perform _po_log('material', m.id, 'stock_count_corrected', format('%s had no drum of %s in the app: a full drum (%sm) added on PO %s', v_place, m.name, _po_qty(m.pack_qty), v_num));
        end if;
      end if;
      if v_left <= 0.005 then
        delete from material_units where id = u.id;
      else
        update material_units set qty_left = round(v_left, 2), updated_at = now() where id = u.id;
        v_unit := u.id;
      end if;
      perform _stock_adjust(m.id, p_source, p_vehicle_id, v_left - u.qty_left, true);
      if abs((u.qty_left - v_qty) - v_left) > 0.005 then
        perform _po_log('material', m.id, 'stock_count_corrected', format('Drum at %s corrected on PO %s: app had %sm, actually %sm (took %sm, %sm left)',
          v_place, v_num, _po_qty(u.qty_left), _po_qty(v_left + v_qty), _po_qty(v_qty), _po_qty(v_left)));
      end if;
      if v_left <= 0.005 then perform _po_log('material', m.id, 'drum_finished', format('Drum finished at %s on PO %s', v_place, v_num)); end if;
    else
      select coalesce(sum(quantity), 0) into v_have from material_stock_by_location
        where material_id = m.id and location_type = p_source and (p_source = 'warehouse' or vehicle_id = p_vehicle_id);
      v_left := nullif(v_line->>'left_after', '')::numeric;
      if v_left is null then
        if v_qty > v_have then
          raise exception 'The app says % % in %. Say how many are left after you take %.', _po_qty(v_have), m.name, v_place, _po_qty(v_qty);
        end if;
        v_left := v_have - v_qty;
      end if;
      if v_left < 0 then raise exception 'Left after cannot be below 0 (%).', m.name; end if;

      perform _stock_adjust(m.id, p_source, p_vehicle_id, v_left - v_have, true);
      if v_left <> v_have - v_qty then
        perform _po_log('material', m.id, 'stock_count_corrected', format('%s count corrected on PO %s: app had %s, actually %s (took %s, %s left)',
          v_place, v_num, _po_qty(v_have), _po_qty(v_left + v_qty), _po_qty(v_qty), _po_qty(v_left)));
      end if;
    end if;

    insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by,
        received, destination_type, destination_job_id, received_by, received_at, material_unit_id)
    values (v_po, m.id, m.name, v_qty, coalesce(m.cost_price, 0), auth.uid(), true, 'job', p_project_id, auth.uid(), now(), v_unit)
    returning id into v_li;
    insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, po_line_item_id, created_by)
    values (p_project_id, p_cost_centre_id, m.id, v_qty, coalesce(m.cost_price, 0), 'from_stock', v_li, auth.uid());
    v_summary := v_summary || format('%s%s x %s', _po_qty(v_qty), case when m.kind = 'cable' then 'm' else '' end, m.name);
  end loop;

  perform _po_log('purchase_order', v_po, 'created', format('Stock PO %s: pulled %s from %s for %s%s', v_num, array_to_string(v_summary, ', '), v_place, _po_job_ref(p_project_id),
    case when cardinality(v_needs_price) > 0 then ' (needs a price: ' || array_to_string(v_needs_price, ', ') || ')' else '' end));
  perform _po_log('project', p_project_id, 'po_created', format('Stock PO %s: pulled %s from %s%s', v_num, array_to_string(v_summary, ', '), v_place,
    case when cardinality(v_needs_price) > 0 then ' (needs a price: ' || array_to_string(v_needs_price, ', ') || ')' else '' end));
  perform _po_sync_received(v_po);
  return jsonb_build_object('id', v_po, 'po_number', v_num, 'needs_price', to_jsonb(v_needs_price));
end;
$$;
revoke all on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) from public, anon;
grant execute on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) to authenticated;

-- Same as migration 20261108000000 plus: metres from a cable stock pull go back onto the drum they
-- came off (or a new drum when that one is finished) before the count moves (item 53).
create or replace function public.po_undo_receive(p_line_id uuid, p_note text default null, p_backorder boolean default false, p_eta date default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  m materials;
  v_from text;
  v_text text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  if not li.received then raise exception 'That line is not received.'; end if;
  select * into po from purchase_orders where id = li.po_id for update;
  if po.closed_at is not null then
    if not is_finance_role() then raise exception 'PO % is closed. Ask Admin or Finance to reopen it first.', po.po_number; end if;
    if v_note is null then raise exception 'This PO is closed and approved for payment. Add a note saying why it is not received.'; end if;
    update purchase_orders set closed_at = null, closed_by = null, locked = false,
      approved_for_payment = false, approved_by = null, approved_at = null where id = po.id;
    update supplier_bills set approved_for_payment = false, approved_by = null, approved_at = null, pay_on = null
      where po_id = po.id and not paid and approved_for_payment;
    perform _po_log('purchase_order', po.id, 'reopened', format('PO %s reopened (undo received): %s', po.po_number, v_note));
    if po.project_id is not null then perform _po_log('project', po.project_id, 'po_reopened', format('PO %s reopened (undo received): %s', po.po_number, v_note)); end if;
  elsif (po.approved_for_payment or exists (select 1 from supplier_bills where po_id = po.id and approved_for_payment)) and v_note is null then
    raise exception 'A bill on this PO is approved for payment. Add a note saying why it is not received.';
  end if;

  v_from := _po_place_label(li.destination_type, li.destination_job_id, li.destination_vehicle_id);
  perform _po_line_take_back(li.id, li.quantity);
  -- the gear goes back where its first receive took it from (same rule as _po_line_land)
  if po.stock_source is not null then
    if _is_drum_item(li.material_id) then
      select * into m from materials where id = li.material_id;
      if li.material_unit_id is not null and exists (select 1 from material_units where id = li.material_unit_id) then
        update material_units set qty_left = round(qty_left + li.quantity, 2), updated_at = now() where id = li.material_unit_id;
      else
        insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, label, created_by)
        values (m.id, po.stock_source, po.stock_source_vehicle_id, round(li.quantity, 2), m.pack_qty, 'Back from ' || _po_job_ref(li.destination_job_id), auth.uid());
      end if;
    end if;
    perform _stock_adjust(li.material_id, po.stock_source, po.stock_source_vehicle_id, li.quantity);
  elsif po.vehicle_id is not null and po.supplier_id is null then
    perform _stock_adjust(li.material_id, 'warehouse', null, li.quantity);
  end if;

  update purchase_order_line_items set
    received = false, destination_type = null, destination_job_id = null, destination_vehicle_id = null,
    received_by = null, received_at = null,
    is_backordered = coalesce(p_backorder, false), backorder_eta = case when p_backorder then p_eta end
  where id = li.id;

  v_text := format('%s x%s no longer received (was at %s)%s%s', li.description, _po_qty(li.quantity), v_from,
    case when p_backorder then ', marked back ordered' || coalesce(' - ETA ' || to_char(p_eta, 'DD Mon'), '') else '' end,
    coalesce(': ' || v_note, ''));
  perform _po_log('purchase_order', po.id, 'item_unreceived', v_text);
  if li.destination_type = 'job' then
    perform _po_log('project', li.destination_job_id, 'material_unreceived', format('PO %s: %s', po.po_number, v_text));
  end if;
  perform _po_sync_received(po.id);
end;
$$;
revoke all on function public.po_undo_receive(uuid, text, boolean, date) from public, anon;
grant execute on function public.po_undo_receive(uuid, text, boolean, date) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 6. Stocktake per drum, scan sets the count
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261110000000 plus drum lines (item 53): { unit_id, count } sets what is left on
-- a drum, { material_id, add_unit } adds a drum the app did not know about.
create or replace function public.stock_stocktake(p_loc text, p_vehicle_id uuid, p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb;
  v_changed integer := 0;
  v_low integer := 0;
  v_have numeric;
  v_mat uuid;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  if jsonb_typeof(p_counts) <> 'array' then raise exception 'Nothing to save.'; end if;
  for v_line in select * from jsonb_array_elements(p_counts) loop
    v_mat := nullif(v_line->>'material_id', '')::uuid;
    if nullif(v_line->>'unit_id', '') is not null then
      if nullif(v_line->>'count', '') is not null then
        perform material_unit_set((v_line->>'unit_id')::uuid, (v_line->>'count')::numeric, 'Stocktake');
        v_changed := v_changed + 1;
      end if;
    elsif nullif(v_line->>'add_unit', '') is not null then
      perform material_unit_add(v_mat, p_loc, p_vehicle_id, (v_line->>'add_unit')::numeric, 'Stocktake');
      v_changed := v_changed + 1;
    elsif v_line ? 'state' then
      if v_line->>'state' = 'out' then
        perform stock_set_count(v_mat, p_loc, p_vehicle_id, 0, 'Stocktake: out');
        perform stock_flag_low(v_mat, p_loc, p_vehicle_id, 'Stocktake: out');
        v_changed := v_changed + 1; v_low := v_low + 1;
      elsif v_line->>'state' = 'low' then
        perform stock_flag_low(v_mat, p_loc, p_vehicle_id, 'Stocktake: low');
        v_low := v_low + 1;
      end if;
    elsif v_line ? 'count' and nullif(v_line->>'count', '') is not null then
      select coalesce(sum(quantity), 0) into v_have from material_stock_by_location
        where material_id = v_mat and location_type = p_loc and (p_loc = 'warehouse' or vehicle_id = p_vehicle_id);
      if (v_line->>'count')::numeric <> v_have then
        perform stock_set_count(v_mat, p_loc, p_vehicle_id, (v_line->>'count')::numeric, 'Stocktake');
        v_changed := v_changed + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('changed', v_changed, 'low', v_low);
end;
$$;
revoke all on function public.stock_stocktake(text, uuid, jsonb) from public, anon;
grant execute on function public.stock_stocktake(text, uuid, jsonb) to authenticated;

-- Same as migration 20261128050000 plus (item 53): kind, pack_qty and pack_label from the label reader
-- or the person; set_count (the clock-out panel's Took + Left is the whole count at that place, so it
-- is set, not added); a cable item gets a drum of that many metres and the drum id comes back.
create or replace function public.material_add_from_scan(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_id uuid;
  v_existed boolean := false;
  v_name text := nullif(trim(coalesce(p->>'name', '')), '');
  v_part text := nullif(trim(coalesce(p->>'part_number', '')), '');
  v_barcode text := nullif(trim(coalesce(p->>'barcode', '')), '');
  v_brand text := nullif(trim(coalesce(p->>'brand', '')), '');
  v_loc text := coalesce(p->>'location_type', 'warehouse');
  v_vehicle uuid := nullif(p->>'vehicle_id', '')::uuid;
  v_qty numeric := coalesce((p->>'quantity')::numeric, 0);
  v_kind text := nullif(p->>'kind', '');
  v_pack numeric := nullif(p->>'pack_qty', '')::numeric;
  v_set boolean := coalesce((p->>'set_count')::boolean, false);
  v_have numeric;
  v_unit uuid;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if v_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  if v_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = v_vehicle and holds_stock) then raise exception 'Pick the vehicle.'; end if;
  if v_qty < 0 then raise exception 'The count cannot be below 0.'; end if;
  if v_kind is not null and v_kind not in ('part', 'cable', 'consumable') then raise exception 'Part, cable or consumable?'; end if;
  v_id := nullif(p->>'material_id', '')::uuid;
  if v_id is null and not coalesce((p->>'force_new')::boolean, false) then v_id := _material_by_code(v_barcode, v_part); end if;
  if v_id is not null then
    select * into m from materials where id = v_id for update;
    if not found then raise exception 'Stock item not found.'; end if;
    v_existed := true;
    update materials set
      part_number = coalesce(part_number, v_part), barcode = coalesce(barcode, v_barcode),
      brand = coalesce(brand, v_brand), photo_path = coalesce(photo_path, nullif(p->>'photo_path', ''))
    where id = m.id;
  else
    if v_name is null then raise exception 'Give the part a name.'; end if;
    insert into materials (name, part_number, barcode, brand, category, photo_path, cost_price, sell_price, needs_price, kind, pack_qty, pack_label, created_by)
    values (v_name, v_part, v_barcode, v_brand, nullif(trim(coalesce(p->>'category', '')), ''), nullif(p->>'photo_path', ''), 0, 0, true,
            v_kind, v_pack, nullif(trim(coalesce(p->>'pack_label', '')), ''), auth.uid())
    returning * into m;
    perform _po_log('material', m.id, 'created', format('Added to Stock from a photo of the label%s%s, needs a price%s%s', coalesce(' (part ' || v_part || ')', ''), coalesce(' barcode ' || v_barcode, ''),
      case when m.kind = 'cable' then format(' (cable, drum of %sm)', _po_qty(m.pack_qty)) when m.kind = 'consumable' then ' (consumable)' else '' end,
      case when v_qty > 0 then format('; %s at %s', _po_qty(v_qty), _po_place_label(v_loc, null, v_vehicle)) else '' end));
  end if;

  if v_qty > 0 then
    if _is_drum_item(m.id) then
      -- one drum with that many metres on it
      insert into material_units (material_id, location_type, vehicle_id, qty_left, pack_qty, created_by)
      values (m.id, v_loc, case when v_loc = 'vehicle' then v_vehicle end, round(v_qty, 2), m.pack_qty, auth.uid())
      returning id into v_unit;
      perform _stock_adjust(m.id, v_loc, v_vehicle, v_qty);
      if v_existed then perform _po_log('material', m.id, 'scanned', format('Scanned on site: a drum of %sm added at %s', _po_qty(v_qty), _po_place_label(v_loc, null, v_vehicle))); end if;
    elsif v_existed and v_set then
      select coalesce(sum(quantity), 0) into v_have from material_stock_by_location
        where material_id = m.id and location_type = v_loc and (v_loc = 'warehouse' or vehicle_id = v_vehicle);
      perform _stock_adjust(m.id, v_loc, v_vehicle, v_qty - v_have, true);
      perform _po_log('material', m.id, 'scanned', format('Scanned on site: %s count set to %s (app had %s)', _po_place_label(v_loc, null, v_vehicle), _po_qty(v_qty), _po_qty(v_have)));
    elsif v_existed then
      perform _po_log('material', m.id, 'scanned', format('Scanned on site: %s added to %s (now %s)', _po_qty(v_qty), _po_place_label(v_loc, null, v_vehicle), _po_qty(_stock_adjust(m.id, v_loc, v_vehicle, v_qty))));
    else
      perform _stock_adjust(m.id, v_loc, v_vehicle, v_qty);
    end if;
  elsif v_existed then
    perform _po_log('material', m.id, 'scanned', 'Scanned on site');
  end if;
  return jsonb_build_object('material_id', m.id, 'existed', v_existed, 'name', m.name, 'needs_price', coalesce(m.needs_price, false),
    'kind', m.kind, 'pack_qty', m.pack_qty, 'unit_id', v_unit);
end;
$$;
revoke all on function public.material_add_from_scan(jsonb) from public, anon;
grant execute on function public.material_add_from_scan(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 7. Prices: first price lands whoever bills it; cable per metre
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261128050000 plus (item 53):
--  * a $0 item takes its first price from any supplier (that supplier becomes Buy from only when the
--    item had none);
--  * cable is priced per metre: the line's unit (m, metre: as is; drum, roll, coil, each: divided by
--    the drum size), else its quantity (a whole number of drums' worth of metres means per metre, a
--    small count means per drum); a price list line with neither waits for a person.
drop function if exists public.material_supplier_price_set(uuid, uuid, numeric, text, text, text, uuid, uuid, uuid, boolean);
create or replace function public.material_supplier_price_set(
  p_material_id uuid, p_supplier_id uuid, p_cost numeric, p_source text,
  p_part_number text default null, p_description text default null,
  p_bill_id uuid default null, p_import_id uuid default null,
  p_price_item_id uuid default null, p_checked boolean default true,
  p_qty numeric default null, p_unit text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m materials;
  s suppliers;
  v_key text;
  v_link material_supplier_links;
  v_new_link boolean := false;
  v_buy boolean := false;
  v_old numeric;
  v_pct numeric;
  v_apply boolean := false;
  v_from text;
  v_reason text;
  v_unit text := lower(trim(coalesce(p_unit, '')));
  v_per_drum boolean;
  v_cable_unknown boolean := false;
begin
  if auth.uid() is not null and not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can set prices.'; end if;
  if p_source not in ('price_list', 'bill') then raise exception 'Unknown price source.'; end if;
  if p_cost is null or p_cost <= 0 then return jsonb_build_object('applied', false, 'waiting', false); end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  select * into s from suppliers where id = p_supplier_id;
  if not found then raise exception 'Supplier not found.'; end if;
  p_cost := round(p_cost, 4);
  v_key := case when _part_norm(p_part_number) is not null then 'p:' || _part_norm(p_part_number)
                else 'd:' || trim(regexp_replace(lower(coalesce(nullif(p_description, ''), m.name)), '[^a-z0-9]+', ' ', 'g')) end;
  v_from := case when p_source = 'bill' then 'bill ' || coalesce((select bill_number from supplier_bills where id = p_bill_id), '') else 'price list' end;

  -- cable: the price kept is per metre
  if m.kind = 'cable' and coalesce(m.pack_qty, 0) > 0 then
    if v_unit ~ '^(m|mt|mtr|mtrs|metre|metres|meter|meters|lm|/m|per m|per metre)$' then v_per_drum := false;
    elsif v_unit ~ '^(drum|drums|roll|rolls|coil|coils|reel|reels|each|ea|unit|units|pc|pcs)$' then v_per_drum := true;
    elsif p_qty is not null and p_qty >= m.pack_qty then v_per_drum := false;
    elsif p_qty is not null then v_per_drum := true;
    elsif p_source = 'bill' then v_per_drum := true;
    else v_cable_unknown := true; v_per_drum := p_cost >= 20; end if;
    if v_per_drum then p_cost := round(p_cost / m.pack_qty, 4); end if;
  end if;

  select * into v_link from material_supplier_links where material_id = m.id and supplier_id = s.id for update;
  if not found then
    insert into material_supplier_links (material_id, supplier_id, item_key, part_number, supplier_description, confirmed_by, last_cost, last_cost_at, last_cost_source, last_bill_id)
    values (m.id, s.id, v_key, nullif(trim(coalesce(p_part_number, '')), ''), nullif(left(coalesce(p_description, ''), 500), ''), auth.uid(), p_cost, now(), p_source, p_bill_id)
    returning * into v_link;
    v_new_link := true;
  else
    update material_supplier_links set
      item_key = case when v_key like 'p:%' then v_key else item_key end,
      part_number = coalesce(nullif(trim(coalesce(p_part_number, '')), ''), part_number),
      supplier_description = coalesce(nullif(left(coalesce(p_description, ''), 500), ''), supplier_description),
      last_cost = p_cost, last_cost_at = now(), last_cost_source = p_source, last_bill_id = coalesce(p_bill_id, last_bill_id)
    where id = v_link.id;
  end if;

  -- whose price is our cost price: the item's Buy from supplier, the first one to price it, or anyone
  -- while the item is still at $0 (a part added from site waits for its first price)
  v_old := coalesce(m.cost_price, 0);
  if m.supplier_id is null then
    update materials set supplier_id = s.id, supplier = s.name where id = m.id;
    v_buy := true;
  elsif m.supplier_id = s.id then
    v_buy := true;
  elsif v_old <= 0 then
    v_buy := true;
  end if;

  if not v_buy then
    if v_new_link or v_link.last_cost is null or abs(v_link.last_cost - p_cost) >= 0.005 then
      perform _po_log('material', m.id, 'supplier_price', format('%s: $%s from %s (we buy from %s at $%s)', s.name, to_char(p_cost, 'FM999G999G990D00'), v_from,
        coalesce((select name from suppliers where id = m.supplier_id), 'another supplier'), to_char(v_old, 'FM999G999G990D00')));
    end if;
    return jsonb_build_object('applied', false, 'waiting', false);
  end if;
  if abs(p_cost - v_old) < 0.005 then
    return jsonb_build_object('applied', false, 'waiting', false);
  end if;

  v_pct := case when v_old > 0 then round((p_cost - v_old) / v_old * 100, 1) end;
  if v_cable_unknown then
    v_reason := format('Cable: $%s on the %s read as per %s. Check it is per metre before applying', to_char(case when v_per_drum then p_cost * m.pack_qty else p_cost end, 'FM999G999G990D00'), v_from, case when v_per_drum then 'drum' else 'metre' end);
  elsif p_source = 'bill' and p_checked then
    v_apply := true; v_reason := format('What we paid on %s from %s', v_from, s.name);
  elsif v_old = 0 then
    v_apply := true; v_reason := format('First price, from %s''s %s', s.name, v_from);
  elsif abs(v_pct) < 20 then
    v_apply := true; v_reason := format('Small change (%s%s%%), applied automatically', case when v_pct > 0 then '+' else '' end, v_pct);
  else
    v_reason := format('Big change (%s%s%%)%s, check before applying', case when v_pct > 0 then '+' else '' end, v_pct, case when p_source = 'bill' then ' on ' || v_from || ', saved with nobody looking' else '' end);
  end if;
  if v_new_link and v_key like 'p:%' then v_reason := v_reason || format('. Linked by part number %s', trim(p_part_number)); end if;
  if m.kind = 'cable' and coalesce(m.pack_qty, 0) > 0 and not v_cable_unknown then v_reason := v_reason || case when v_per_drum then format(' (per drum of %sm, kept per metre)', _po_qty(m.pack_qty)) else ' (per metre)' end; end if;

  insert into price_changes (import_id, bill_id, source, supplier_price_item_id, material_id, supplier_id, kind, old_cost, new_cost, change_pct, old_name, new_name, reason, status, resolved_at, resolved_by)
  values (p_import_id, p_bill_id, p_source, p_price_item_id, m.id, s.id, case when v_new_link then 'match' else 'price' end, v_old, p_cost, v_pct, m.name,
          case when v_new_link then coalesce(nullif(p_description, ''), p_part_number, m.name) end, v_reason,
          case when v_apply then 'applied' else 'waiting' end, case when v_apply then now() end, case when v_apply then auth.uid() end);

  if v_apply then
    update materials set cost_price = p_cost where id = m.id;  -- trg_materials_price_fill clears needs_price and fills $0 lines
    perform _po_log('material', m.id, 'priced', format('Cost $%s -> $%s from %s''s %s%s', to_char(v_old, 'FM999G999G990D00'), to_char(p_cost, 'FM999G999G990D00'), s.name, v_from,
      case when m.kind = 'cable' then ' (per metre)' else '' end));
  end if;
  return jsonb_build_object('applied', v_apply, 'waiting', not v_apply);
end;
$$;
revoke all on function public.material_supplier_price_set(uuid, uuid, numeric, text, text, text, uuid, uuid, uuid, boolean, numeric, text) from public, anon;
grant execute on function public.material_supplier_price_set(uuid, uuid, numeric, text, text, text, uuid, uuid, uuid, boolean, numeric, text) to authenticated;

-- Same as migration 20261128050000 plus the line's quantity and unit for the cable rule (item 53).
create or replace function public.supplier_bill_price_lines(p_bill_id uuid, p_checked boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare
  b supplier_bills;
  l supplier_bill_line_items;
begin
  if auth.uid() is not null and not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can set prices.'; end if;
  select * into b from supplier_bills where id = p_bill_id;
  if not found then raise exception 'Bill not found.'; end if;
  for l in select * from supplier_bill_line_items where bill_id = b.id and material_id is not null and unit_cost > 0 and not _is_freight(description) order by created_at loop
    perform material_supplier_price_set(l.material_id, b.supplier_id, l.unit_cost, 'bill', l.part_number, l.description, b.id, null, null, p_checked, l.quantity, l.unit);
  end loop;
end;
$$;
revoke all on function public.supplier_bill_price_lines(uuid, boolean) from public, anon;
grant execute on function public.supplier_bill_price_lines(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 8. Existing items get a kind; existing cable counts become drums
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  r record;
  g jsonb;
  v_kind text;
begin
  for r in select id, name, category, is_consumable, pack_qty from materials where kind is null loop
    if r.is_consumable then
      update materials set kind = 'consumable' where id = r.id;
    else
      g := _stock_kind_guess(r.name, r.category);
      v_kind := g->>'kind';
      update materials set kind = v_kind,
        pack_qty = case when v_kind = 'cable' then coalesce(r.pack_qty, (g->>'pack_qty')::numeric, 100) end
        where id = r.id;
      if v_kind = 'cable' then
        perform _po_log('material', r.id, 'updated', format('Marked as cable by the stock kinds update (drum of %sm): the count is in metres, check the drums', _po_qty(coalesce(r.pack_qty, (g->>'pack_qty')::numeric, 100))));
      elsif v_kind = 'consumable' then
        perform _po_log('material', r.id, 'updated', 'Marked as a consumable by the stock kinds update: counted by the pack, not asked about at clock-out');
      end if;
    end if;
  end loop;
  for r in select l.material_id, l.location_type, l.vehicle_id from material_stock_by_location l join materials m on m.id = l.material_id
      where m.kind = 'cable' and l.quantity > 0 loop
    perform _material_units_reconcile(r.material_id, r.location_type, r.vehicle_id);
  end loop;
end $$;
alter table public.materials alter column kind set not null;
