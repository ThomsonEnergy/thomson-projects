-- Stock from My Day (docs/PO_REVIEW.md Delivery 3: G4, G5, G6, P17, owner's answers 5, 8, 10).
--
--  * Used stock on My Day and the clock-out prompt make a stock PO through po_create_stock_pull, which
--    now also takes a part that is not in Stock yet (new_name): the item is made with cost 0 and flagged
--    "Needs a price" (materials.needs_price) for Admin / Finance; when it is priced, the stock pull lines
--    and the job's cost rows that were at 0 take the price (trigger).
--  * Consumables (materials.is_consumable, counted by the pack, pack_label) are never asked about at
--    clock-out. Anyone can flag one "Running low" at a place (stock_low_flags); Admin and Finance get a
--    notification and the Stock page lists them until cleared.
--  * stock_transfer moves gear between the Warehouse and a vehicle in one step (no PO), fixing the
--    source count on the spot like a stock pull.
--  * stock_stocktake: one Save for a whole place (every count typed, differences logged as corrections;
--    consumables as OK / Low / Out).

alter table public.materials
  add column if not exists is_consumable boolean not null default false,
  add column if not exists pack_label text,
  add column if not exists needs_price boolean not null default false,
  add column if not exists created_by uuid references public.profiles(id) on delete set null;
create index if not exists materials_created_by_idx on public.materials (created_by);
create index if not exists materials_needs_price_idx on public.materials (needs_price) where needs_price;

create table if not exists public.stock_low_flags (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  location_type text not null check (location_type in ('warehouse', 'vehicle')),
  vehicle_id uuid references public.fleet_vehicles(id) on delete cascade,
  flagged_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references public.profiles(id) on delete set null
);
create index if not exists stock_low_flags_material_id_idx on public.stock_low_flags (material_id);
create index if not exists stock_low_flags_vehicle_id_idx on public.stock_low_flags (vehicle_id);
create index if not exists stock_low_flags_flagged_by_idx on public.stock_low_flags (flagged_by);
create index if not exists stock_low_flags_cleared_by_idx on public.stock_low_flags (cleared_by);
create index if not exists stock_low_flags_open_idx on public.stock_low_flags (material_id, location_type, vehicle_id) where cleared_at is null;

alter table public.stock_low_flags enable row level security;
drop policy if exists "Everyone can view stock low flags" on public.stock_low_flags;
create policy "Everyone can view stock low flags" on public.stock_low_flags for select to authenticated using (true);

-- A part priced for the first time: the stock pull lines and job cost rows that were waiting at 0 take it.
create or replace function public.materials_price_fill()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.cost_price, 0) > 0 and coalesce(old.cost_price, 0) = 0 then
    new.needs_price := false;
    perform set_config('teops.po_step', 'on', true);
    update purchase_order_line_items l set unit_cost = new.cost_price
      from purchase_orders p where p.id = l.po_id and p.stock_source is not null and l.material_id = new.id and coalesce(l.unit_cost, 0) = 0;
    update job_material_usage set unit_cost = new.cost_price where material_id = new.id and coalesce(unit_cost, 0) = 0;
    perform _po_log('material', new.id, 'priced', format('Priced at $%s: stock pull lines and job costs that were at $0 updated', to_char(new.cost_price, 'FM999G999G990D00')));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_materials_price_fill on public.materials;
create trigger trg_materials_price_fill before update of cost_price on public.materials
  for each row execute function public.materials_price_fill();

-- Stock PO on a job (same as migration 20261025000000) plus parts not in Stock yet:
-- p_lines: [{ "material_id": uuid | null, "new_name": text | null, "quantity": n, "left_after": n or null }]
create or replace function public.po_create_stock_pull(p_project_id uuid, p_cost_centre_id uuid, p_source text, p_vehicle_id uuid, p_lines jsonb, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_po uuid;
  v_num text;
  v_place text;
  v_line jsonb;
  m materials;
  v_qty numeric;
  v_have numeric;
  v_left numeric;
  v_li uuid;
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

    insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by,
        received, destination_type, destination_job_id, received_by, received_at)
    values (v_po, m.id, m.name, v_qty, coalesce(m.cost_price, 0), auth.uid(), true, 'job', p_project_id, auth.uid(), now())
    returning id into v_li;
    insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, po_line_item_id, created_by)
    values (p_project_id, p_cost_centre_id, m.id, v_qty, coalesce(m.cost_price, 0), 'from_stock', v_li, auth.uid());
    v_summary := v_summary || format('%s x %s', _po_qty(v_qty), m.name);
  end loop;

  perform _po_log('purchase_order', v_po, 'created', format('Stock PO %s: pulled %s from %s for %s%s', v_num, array_to_string(v_summary, ', '), v_place, _po_job_ref(p_project_id),
    case when cardinality(v_needs_price) > 0 then ' (needs a price: ' || array_to_string(v_needs_price, ', ') || ')' else '' end));
  perform _po_log('project', p_project_id, 'po_created', format('Stock PO %s: pulled %s from %s%s', v_num, array_to_string(v_summary, ', '), v_place,
    case when cardinality(v_needs_price) > 0 then ' (needs a price: ' || array_to_string(v_needs_price, ', ') || ')' else '' end));
  perform _po_sync_received(v_po);
  return jsonb_build_object('id', v_po, 'po_number', v_num, 'needs_price', to_jsonb(v_needs_price));
end;
$$;

-- "Running low" at a place. One open flag per item and place; Admin and Finance are told once.
create or replace function public.stock_flag_low(p_material_id uuid, p_loc text, p_vehicle_id uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_id uuid;
  v_place text;
  r record;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  select * into m from materials where id = p_material_id;
  if not found then raise exception 'Stock item not found.'; end if;
  select id into v_id from stock_low_flags where material_id = m.id and location_type = p_loc
    and (p_loc = 'warehouse' or vehicle_id = p_vehicle_id) and cleared_at is null limit 1;
  if v_id is not null then return v_id; end if;
  insert into stock_low_flags (material_id, location_type, vehicle_id, flagged_by, note)
  values (m.id, p_loc, case when p_loc = 'vehicle' then p_vehicle_id end, auth.uid(), nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  v_place := _po_place_label(p_loc, null, p_vehicle_id);
  perform _po_log('material', m.id, 'running_low', format('Running low in %s', v_place));
  for r in select id from profiles where active and role in ('admin', 'finance') loop
    perform create_notification(r.id, 'stock_low', format('Running low: %s', m.name), format('%s in %s, flagged by %s', m.name, v_place, coalesce((select full_name from profiles where id = auth.uid()), 'someone')), '/stock.html', auth.uid(), 'stock_low:' || v_id::text);
  end loop;
  return v_id;
end;
$$;

create or replace function public.stock_clear_low(p_flag_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can clear a Running low flag.'; end if;
  update stock_low_flags set cleared_at = now(), cleared_by = auth.uid() where id = p_flag_id and cleared_at is null;
end;
$$;

-- Move gear between the Warehouse and a vehicle in one step (no PO). p_left_after fixes the source count first.
create or replace function public.stock_transfer(p_material_id uuid, p_qty numeric, p_from_loc text, p_from_vehicle uuid, p_to_loc text, p_to_vehicle uuid, p_left_after numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_have numeric;
  v_left numeric;
  v_from text;
  v_to text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_from_loc not in ('warehouse', 'vehicle') or p_to_loc not in ('warehouse', 'vehicle') then raise exception 'Pick where from and where to.'; end if;
  if p_from_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_from_vehicle and holds_stock) then raise exception 'Pick the vehicle it comes from.'; end if;
  if p_to_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_to_vehicle and holds_stock) then raise exception 'Pick the vehicle it goes to.'; end if;
  if p_from_loc = p_to_loc and (p_from_loc = 'warehouse' or p_from_vehicle = p_to_vehicle) then raise exception 'That is the same place.'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter how many.'; end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  v_from := _po_place_label(p_from_loc, null, p_from_vehicle);
  v_to := _po_place_label(p_to_loc, null, p_to_vehicle);
  select coalesce(sum(quantity), 0) into v_have from material_stock_by_location
    where material_id = m.id and location_type = p_from_loc and (p_from_loc = 'warehouse' or vehicle_id = p_from_vehicle);
  v_left := p_left_after;
  if v_left is null then
    if p_qty > v_have then raise exception 'The app says % % in %. Say how many are left after you take %.', _po_qty(v_have), m.name, v_from, _po_qty(p_qty); end if;
    v_left := v_have - p_qty;
  end if;
  if v_left < 0 then raise exception 'Left after cannot be below 0.'; end if;
  perform _stock_adjust(m.id, p_from_loc, p_from_vehicle, v_left - v_have, true);
  if v_left <> v_have - p_qty then
    perform _po_log('material', m.id, 'stock_count_corrected', format('%s count corrected on a move to %s: app had %s, actually %s (moved %s, %s left)', v_from, v_to, _po_qty(v_have), _po_qty(v_left + p_qty), _po_qty(p_qty), _po_qty(v_left)));
  end if;
  perform _stock_adjust(m.id, p_to_loc, p_to_vehicle, p_qty);
  perform _po_log('material', m.id, 'stock_moved', format('%s moved from %s to %s', _po_qty(p_qty), v_from, v_to));
end;
$$;

-- Stocktake of one place. p_counts: [{ "material_id": uuid, "count": n }] for counted items and
-- [{ "material_id": uuid, "state": "ok" | "low" | "out" }] for consumables. Returns how many changed.
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
    v_mat := (v_line->>'material_id')::uuid;
    if v_line ? 'state' then
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

revoke all on function public.materials_price_fill() from public, anon, authenticated;
revoke all on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) from public, anon;
revoke all on function public.stock_flag_low(uuid, text, uuid, text) from public, anon;
revoke all on function public.stock_clear_low(uuid) from public, anon;
revoke all on function public.stock_transfer(uuid, numeric, text, uuid, text, uuid, numeric) from public, anon;
revoke all on function public.stock_stocktake(text, uuid, jsonb) from public, anon;
grant execute on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) to authenticated;
grant execute on function public.stock_flag_low(uuid, text, uuid, text) to authenticated;
grant execute on function public.stock_clear_low(uuid) to authenticated;
grant execute on function public.stock_transfer(uuid, numeric, text, uuid, text, uuid, numeric) to authenticated;
grant execute on function public.stock_stocktake(text, uuid, jsonb) to authenticated;
