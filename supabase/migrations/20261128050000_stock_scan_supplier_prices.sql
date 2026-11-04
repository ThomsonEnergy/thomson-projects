-- Scan a part into Stock, one price per supplier (docs/IDEAS_BACKLOG.md item 44, spec A12 and A11b).
--
--  * materials: part_number, barcode, brand and photo_path, so a photo of the label can make the
--    item and a price list or bill can find it again by part number.
--  * material_add_from_scan: anyone logged in makes the item at $0 ("Needs a price") with the count
--    where they are, or adds the count to the item that already has that barcode or part number.
--  * material_supplier_links keeps each supplier's last price (last_cost, from a price list or a
--    bill). materials.cost_price follows the item's Buy from supplier (materials.supplier_id).
--  * material_supplier_price_set: the one way a supplier's price lands on an item. Used by the bill
--    save (reviewed, one tap and automatic), the price list reader and nothing else. A bill a person
--    saved is applied straight away (it is what we paid); a bill saved with nobody looking (auto-save)
--    and a price list follow the 20% rule (under 20% applied, 20% or more waits for a person, a $0
--    item is priced straight away).
--    Every applied change is a price_changes row with Undo on the Price lists page.
--  * material_set_buy_from: "Buy from this one" on the Stock page.
--  * supplier_bill_line_items.part_number: Tally reads the product code on each bill line.
--  * supplier_bill_save_review: lines also match Stock by part number or barcode, and every linked
--    line sets that supplier's price (replaces the direct cost update, which ignored the supplier).

alter table public.materials
  add column if not exists part_number text,
  add column if not exists barcode text,
  add column if not exists brand text,
  add column if not exists photo_path text;

alter table public.supplier_bill_line_items add column if not exists part_number text;

alter table public.material_supplier_links
  add column if not exists last_cost numeric,
  add column if not exists last_cost_at timestamptz,
  add column if not exists last_cost_source text,
  add column if not exists last_bill_id uuid references public.supplier_bills(id) on delete set null;
alter table public.material_supplier_links drop constraint if exists material_supplier_links_source_check;
alter table public.material_supplier_links add constraint material_supplier_links_source_check
  check (last_cost_source is null or last_cost_source in ('price_list', 'bill', 'manual'));
create index if not exists material_supplier_links_last_bill_id_idx on public.material_supplier_links (last_bill_id);

alter table public.price_changes
  add column if not exists source text not null default 'price_list',
  add column if not exists bill_id uuid references public.supplier_bills(id) on delete set null;
alter table public.price_changes drop constraint if exists price_changes_source_check;
alter table public.price_changes add constraint price_changes_source_check check (source in ('price_list', 'bill', 'manual'));
create index if not exists price_changes_bill_id_idx on public.price_changes (bill_id);

-- A part number the way it is compared: case, spaces and dashes ignored (same as the price list
-- reader's item key, "p:" + this).
create or replace function public._part_norm(p text)
returns text language sql immutable set search_path = public as $$
  select nullif(lower(regexp_replace(coalesce(p, ''), '[^a-zA-Z0-9]+', '', 'g')), '');
$$;
revoke all on function public._part_norm(text) from public, anon;
grant execute on function public._part_norm(text) to authenticated;

create index if not exists materials_part_number_norm_idx on public.materials (_part_norm(part_number)) where part_number is not null;
create index if not exists materials_barcode_idx on public.materials (barcode) where barcode is not null;

-- The Stock item with this barcode, else this part number (normalised). Null when none.
create or replace function public._material_by_code(p_barcode text, p_part_number text)
returns uuid language sql stable set search_path = public as $$
  select id from materials
    where (nullif(trim(coalesce(p_barcode, '')), '') is not null and barcode = trim(p_barcode))
       or (_part_norm(p_part_number) is not null and _part_norm(part_number) = _part_norm(p_part_number))
    order by (barcode = trim(coalesce(p_barcode, ''))) desc nulls last, created_at
    limit 1;
$$;
revoke all on function public._material_by_code(text, text) from public, anon;
grant execute on function public._material_by_code(text, text) to authenticated, service_role;

-- One supplier's price for one item. Keeps the supplier link (part number, last price, where it
-- came from), moves materials.cost_price when the supplier is the item's Buy from one (an item with
-- no Buy from takes this supplier), and writes the price_changes row. Returns
-- { applied, waiting, buy_from, change_id, new_link }.
--   p_source: 'price_list' or 'bill'; p_bill_id / p_import_id / p_price_item_id: where the price came
--   from (the supplier_price_items row lets a person apply a waiting change on the Price lists page);
--   p_checked: a person saved this bill (false for the unattended auto-save, which follows the 20% rule).
-- Called from supplier_bill_save_review (a pricing role) and the server (service role).
create or replace function public.material_supplier_price_set(
  p_material_id uuid, p_supplier_id uuid, p_cost numeric, p_source text,
  p_part_number text default null, p_description text default null,
  p_bill_id uuid default null, p_import_id uuid default null,
  p_price_item_id uuid default null, p_checked boolean default true)
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
  v_change uuid;
  v_from text;
  v_reason text;
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

  -- whose price is our cost price: the item's Buy from supplier, or the first one to price it
  if m.supplier_id is null then
    update materials set supplier_id = s.id, supplier = s.name where id = m.id;
    v_buy := true;
  elsif m.supplier_id = s.id then
    v_buy := true;
  end if;

  v_old := coalesce(m.cost_price, 0);
  if not v_buy then
    if v_new_link or v_link.last_cost is null or abs(v_link.last_cost - p_cost) >= 0.005 then
      perform _po_log('material', m.id, 'supplier_price', format('%s: $%s from %s (we buy from %s at $%s)', s.name, to_char(p_cost, 'FM999G999G990D00'), v_from,
        coalesce((select name from suppliers where id = m.supplier_id), 'another supplier'), to_char(v_old, 'FM999G999G990D00')));
    end if;
    return jsonb_build_object('applied', false, 'waiting', false, 'buy_from', false, 'new_link', v_new_link);
  end if;
  if abs(p_cost - v_old) < 0.005 then
    return jsonb_build_object('applied', false, 'waiting', false, 'buy_from', true, 'new_link', v_new_link);
  end if;

  v_pct := case when v_old > 0 then round((p_cost - v_old) / v_old * 100, 1) end;
  if p_source = 'bill' and p_checked then
    v_apply := true; v_reason := format('What we paid on %s from %s', v_from, s.name);
  elsif v_old = 0 then
    v_apply := true; v_reason := format('First price, from %s''s %s', s.name, v_from);
  elsif abs(v_pct) < 20 then
    v_apply := true; v_reason := format('Small change (%s%s%%), applied automatically', case when v_pct > 0 then '+' else '' end, v_pct);
  else
    v_reason := format('Big change (%s%s%%)%s, check before applying', case when v_pct > 0 then '+' else '' end, v_pct, case when p_source = 'bill' then ' on ' || v_from || ', saved with nobody looking' else '' end);
  end if;
  if v_new_link and v_key like 'p:%' then v_reason := v_reason || format('. Linked by part number %s', trim(p_part_number)); end if;

  insert into price_changes (import_id, bill_id, source, supplier_price_item_id, material_id, supplier_id, kind, old_cost, new_cost, change_pct, old_name, new_name, reason, status, resolved_at, resolved_by)
  values (p_import_id, p_bill_id, p_source, p_price_item_id, m.id, s.id, case when v_new_link then 'match' else 'price' end, v_old, p_cost, v_pct, m.name,
          case when v_new_link then coalesce(nullif(p_description, ''), p_part_number, m.name) end, v_reason,
          case when v_apply then 'applied' else 'waiting' end, case when v_apply then now() end, case when v_apply then auth.uid() end)
  returning id into v_change;

  if v_apply then
    update materials set cost_price = p_cost where id = m.id;  -- trg_materials_price_fill clears needs_price and fills $0 lines
    perform _po_log('material', m.id, 'priced', format('Cost $%s -> $%s from %s''s %s', to_char(v_old, 'FM999G999G990D00'), to_char(p_cost, 'FM999G999G990D00'), s.name, v_from));
  end if;
  return jsonb_build_object('applied', v_apply, 'waiting', not v_apply, 'buy_from', true, 'change_id', v_change, 'new_link', v_new_link);
end;
$$;
revoke all on function public.material_supplier_price_set(uuid, uuid, numeric, text, text, text, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.material_supplier_price_set(uuid, uuid, numeric, text, text, text, uuid, uuid, uuid, boolean) to authenticated, service_role;

-- "Buy from this one" on the Stock page: the item's supplier and cost price become that supplier's
-- last price. Pricing roles only.
create or replace function public.material_set_buy_from(p_material_id uuid, p_supplier_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m materials;
  s suppliers;
  v_link material_supplier_links;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can change where an item is bought from.'; end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  select * into s from suppliers where id = p_supplier_id;
  if not found then raise exception 'Supplier not found.'; end if;
  select * into v_link from material_supplier_links where material_id = m.id and supplier_id = s.id;
  update materials set supplier_id = s.id, supplier = s.name, cost_price = coalesce(v_link.last_cost, cost_price) where id = m.id;
  if v_link.last_cost is not null and abs(v_link.last_cost - coalesce(m.cost_price, 0)) >= 0.005 then
    insert into price_changes (source, material_id, supplier_id, kind, old_cost, new_cost, change_pct, old_name, reason, status, resolved_at, resolved_by)
    values ('manual', m.id, s.id, 'price', coalesce(m.cost_price, 0), v_link.last_cost,
            case when coalesce(m.cost_price, 0) > 0 then round((v_link.last_cost - m.cost_price) / m.cost_price * 100, 1) end,
            m.name, format('Now bought from %s', s.name), 'applied', now(), auth.uid());
  end if;
  perform _po_log('material', m.id, 'buy_from', format('Now bought from %s%s', s.name,
    case when v_link.last_cost is not null then format(' at $%s', to_char(v_link.last_cost, 'FM999G999G990D00')) else '' end));
end;
$$;
revoke all on function public.material_set_buy_from(uuid, uuid) from public, anon;
grant execute on function public.material_set_buy_from(uuid, uuid) to authenticated;

-- A part scanned on site: p = { material_id, force_new, name, part_number, barcode, brand, category,
-- photo_path, location_type ('warehouse' | 'vehicle'), vehicle_id, quantity }. Makes the item at $0
-- flagged Needs a price, or uses the item that already has that barcode or part number (filling in
-- blanks) unless the person said force_new ("Not the same item?"), and adds the quantity to the
-- count at that place (one "scanned" line on the item, not a count correction).
-- Returns { material_id, existed, name, needs_price }. Anyone logged in.
create or replace function public.material_add_from_scan(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_id uuid;
  v_existed boolean := false;
  v_name text := nullif(trim(coalesce(p->>'name', '')), '');
  v_part text := nullif(trim(coalesce(p->>'part_number', '')), '');
  v_barcode text := nullif(trim(coalesce(p->>'barcode', '')), '');
  v_loc text := coalesce(p->>'location_type', 'warehouse');
  v_vehicle uuid := nullif(p->>'vehicle_id', '')::uuid;
  v_qty numeric := coalesce((p->>'quantity')::numeric, 0);
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if v_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  if v_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = v_vehicle and holds_stock) then raise exception 'Pick the vehicle.'; end if;
  if v_qty < 0 then raise exception 'The count cannot be below 0.'; end if;
  v_id := nullif(p->>'material_id', '')::uuid;
  if v_id is null and not coalesce((p->>'force_new')::boolean, false) then v_id := _material_by_code(v_barcode, v_part); end if;
  if v_id is not null then
    select * into m from materials where id = v_id for update;
    if not found then raise exception 'Stock item not found.'; end if;
    v_existed := true;
    update materials set
      part_number = coalesce(part_number, v_part), barcode = coalesce(barcode, v_barcode),
      brand = coalesce(brand, nullif(trim(coalesce(p->>'brand', '')), '')), photo_path = coalesce(photo_path, nullif(p->>'photo_path', ''))
    where id = m.id;
    perform _po_log('material', m.id, 'scanned', format('Scanned on site%s', case when v_qty > 0 then format(': %s added to %s (now %s)', _po_qty(v_qty), _po_place_label(v_loc, null, v_vehicle), _po_qty(_stock_adjust(m.id, v_loc, v_vehicle, v_qty))) else '' end));
  else
    if v_name is null then raise exception 'Give the part a name.'; end if;
    insert into materials (name, part_number, barcode, brand, category, photo_path, cost_price, sell_price, needs_price, created_by)
    values (v_name, v_part, v_barcode, nullif(trim(coalesce(p->>'brand', '')), ''), nullif(trim(coalesce(p->>'category', '')), ''), nullif(p->>'photo_path', ''), 0, 0, true, auth.uid())
    returning * into m;
    perform _po_log('material', m.id, 'created', format('Added to Stock from a photo of the label%s%s, needs a price%s', coalesce(' (part ' || v_part || ')', ''), coalesce(' barcode ' || v_barcode, ''),
      case when v_qty > 0 then format('; %s at %s', _po_qty(v_qty), _po_place_label(v_loc, null, v_vehicle)) else '' end));
    if v_qty > 0 then perform _stock_adjust(m.id, v_loc, v_vehicle, v_qty); end if;
  end if;
  return jsonb_build_object('material_id', m.id, 'existed', v_existed, 'name', m.name, 'needs_price', coalesce(m.needs_price, false));
end;
$$;
revoke all on function public.material_add_from_scan(jsonb) from public, anon;
grant execute on function public.material_add_from_scan(jsonb) to authenticated;

-- Reviewed bill save (migration 20261124150000) plus: part numbers are kept on the bill lines (the
-- review screen matches a line to the Stock item with that part number or barcode, the person's pick
-- stands), and every line on a Stock item sets that supplier's price through material_supplier_price_set.
create or replace function public.supplier_bill_save_review(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s suppliers;
  v_num text := nullif(trim(coalesce(p->>'bill_number', '')), '');
  v_date date := nullif(p->>'bill_date', '')::date;
  v_mode text := coalesce(p->>'po_mode', 'none');
  v_po_id uuid := nullif(p->>'po_id', '')::uuid;
  v_po_open boolean := false;
  v_po_number text;
  v_dup record;
  v_bill uuid;
  v_markup numeric;
  v_line jsonb;
  v_mat uuid;
  v_po_line uuid;
  v_flag text;
  v_cost numeric;
  v_qty numeric;
  v_desc text;
  v_part text;
  v_added boolean;
  pl purchase_order_line_items;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can save supplier bills.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into s from suppliers where id = (p->>'supplier_id')::uuid;
  if not found then raise exception 'Supplier not found.'; end if;
  if jsonb_typeof(p->'lines') <> 'array' then raise exception 'No line items.'; end if;

  if v_num is not null then
    select id, bill_date, amount into v_dup from supplier_bills
      where supplier_id = s.id and _bill_num_norm(bill_number) = _bill_num_norm(v_num) limit 1;
    if found then
      raise exception 'Bill % from % is already in TEops (%, dated %). Not saved again.', v_num, s.name, '$' || to_char(coalesce(v_dup.amount, 0), 'FM999G999G990D00'), coalesce(to_char(v_dup.bill_date, 'DD Mon YYYY'), 'no date');
    end if;
  end if;

  if v_mode = 'existing' then
    if v_po_id is null then raise exception 'Pick the PO.'; end if;
    select (po_type = 'open' and closed_at is null), po_number into v_po_open, v_po_number from purchase_orders where id = v_po_id and supplier_id = s.id;
    if not found then raise exception 'That PO is not for %.', s.name; end if;
  elsif v_mode = 'new' then
    insert into purchase_orders (project_id, supplier_id, supplier_name, po_type, locked, status, amount, description)
    values (nullif(p->'new_po'->>'project_id', '')::uuid, s.id, s.name, 'fixed', false, 'ordered', 0, ('Created from bill ' || coalesce(v_num, '')))
    returning id into v_po_id;
    perform _po_log('purchase_order', v_po_id, 'created', format('PO created from bill %s (%s)', coalesce(v_num, ''), s.name));
  else
    v_po_id := null;
  end if;

  select coalesce(default_markup_percent, 45) into v_markup from company_settings where id = 1;

  insert into supplier_bills (supplier_id, supplier_name, bill_number, bill_date, due_date, amount, po_id, file_path, file_name, created_by)
  values (s.id, s.name, v_num, v_date, calculate_bill_due_date(v_date, s.credit_terms_type, s.credit_terms_days),
          coalesce((p->>'amount')::numeric, 0), v_po_id, nullif(p->>'file_path', ''), nullif(p->>'file_name', ''), auth.uid())
  returning id into v_bill;

  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_desc := nullif(trim(coalesce(v_line->>'description', '')), '');
    if v_desc is null then continue; end if;
    v_qty := coalesce((v_line->>'quantity')::numeric, 0);
    v_cost := coalesce((v_line->>'unit_cost')::numeric, 0);
    v_part := nullif(trim(coalesce(v_line->>'part_number', '')), '');
    v_mat := nullif(v_line->>'material_id', '')::uuid;
    if coalesce((v_line->>'create_material')::boolean, false) and not _is_freight(v_desc) then
      insert into materials (name, part_number, cost_price, sell_price, supplier_id, supplier)
      values (v_desc, v_part, v_cost, round(v_cost * (1 + v_markup / 100), 2), s.id, s.name)
      returning id into v_mat;
      perform _po_log('material', v_mat, 'created', format('Added to Stock from bill %s (%s)', coalesce(v_num, ''), s.name));
    end if;
    if v_mat is not null and v_cost > 0 and not _is_freight(v_desc) then
      perform material_supplier_price_set(v_mat, s.id, v_cost, 'bill', v_part, v_desc, v_bill, null, null, true);
    end if;

    v_po_line := null;
    v_flag := null;
    v_added := false;
    if v_mode = 'new' and not _is_freight(v_desc) then
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
      values (v_po_id, v_mat, v_desc, v_qty, v_cost, auth.uid()) returning id into v_po_line;
    elsif v_po_id is not null then
      if _is_freight(v_desc) then
        v_flag := 'Freight / delivery charge';
      else
        v_po_line := nullif(v_line->>'replace_po_line_id', '')::uuid;
        if v_po_line is not null then
          select * into pl from purchase_order_line_items where id = v_po_line and po_id = v_po_id for update;
          if not found then
            v_po_line := null;
          else
            update purchase_order_line_items set material_id = coalesce(v_mat, material_id), description = v_desc where id = pl.id;
            -- already on the shelf or the job under its old identity: the count and the cost rows follow the new item (F37)
            if v_mat is not null and v_mat is distinct from pl.material_id and pl.received then
              if pl.destination_type in ('warehouse', 'vehicle') then
                if pl.material_id is not null then perform _stock_adjust(pl.material_id, pl.destination_type, pl.destination_vehicle_id, -pl.quantity, true); end if;
                perform _stock_adjust(v_mat, pl.destination_type, pl.destination_vehicle_id, pl.quantity);
                perform _po_log('material', v_mat, 'received', format('%s added to %s: PO %s line "%s" set to this item from bill %s', _po_qty(pl.quantity), _po_place_label(pl.destination_type, null, pl.destination_vehicle_id), coalesce(v_po_number, ''), v_desc, coalesce(v_num, '')));
                perform _po_log('purchase_order', v_po_id, 'line_item_set', format('"%s" x%s set to the Stock item from bill %s and added to the %s count', v_desc, _po_qty(pl.quantity), coalesce(v_num, ''), _po_place_label(pl.destination_type, null, pl.destination_vehicle_id)));
              elsif pl.destination_type = 'job' then
                update job_material_usage set material_id = v_mat where po_line_item_id = pl.id and material_id is not distinct from pl.material_id;
              end if;
            end if;
          end if;
        end if;
        if v_po_line is null then
          select * into pl from purchase_order_line_items
            where po_id = v_po_id and ((v_mat is not null and material_id = v_mat) or lower(description) = lower(v_desc))
            order by (material_id = v_mat) desc nulls last, created_at limit 1;
          if found then
            v_po_line := pl.id;
            if v_cost > pl.unit_cost * 1.01 + 0.005 then
              v_flag := format('Charged $%s, PO expected $%s', to_char(v_cost, 'FM999G999G990D00'), to_char(pl.unit_cost, 'FM999G999G990D00'));
            end if;
          elsif v_po_open then
            insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
            values (v_po_id, v_mat, v_desc, v_qty, v_cost, auth.uid()) returning id into v_po_line;
            v_added := true;
          else
            v_flag := 'Not on the linked PO';
          end if;
        end if;
      end if;
    end if;

    insert into supplier_bill_line_items (bill_id, material_id, description, part_number, quantity, unit_cost, po_line_item_id, flag_reason, resolution)
    values (v_bill, v_mat, v_desc, v_part, v_qty, v_cost, v_po_line, v_flag, case when v_added then 'added' end);
  end loop;

  perform _po_log('supplier', s.id, 'bill_added', format('Bill %s ($%s) saved%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'),
    case when v_po_id is not null then ' against ' || coalesce((select po_number from purchase_orders where id = v_po_id), 'a PO') else '' end));
  if v_po_id is not null then
    perform _po_log('purchase_order', v_po_id, 'bill_added', format('Bill %s ($%s) from %s saved against this PO%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'), s.name,
      case when v_po_open then ' (open PO: its lines were filled in from the bill)' else '' end));
  end if;
  return v_bill;
end;
$$;
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;
