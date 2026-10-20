-- Tools and equipment register (docs/PO_REVIEW.md Delivery 4: G7, owner's answer 6).
--
--  * tools: every tool and perishable (drill bits, blades, hole saws) the company owns, with where it
--    sits (Warehouse or a vehicle, never a person), status (in use / broken / replaced / lost / sold /
--    written off, with who and when), purchase date, cost, supplier, the bill and PO line it came from,
--    serial number, photo and receipt. Over $500 ex GST a tool needs a serial, a photo and a receipt
--    (the page flags what is missing).
--  * Tools PO (purchase_orders.po_kind 'tools') and any PO line marked as a tool (is_tool, tool_kind):
--    receiving lands it in the register (destination 'tools') at the Warehouse or a vehicle, never on a
--    job's cost and never in stock. Undo received takes the tool rows back out.
--  * Perishables are counted per vehicle, so heavy use shows on the Tools page's By vehicle view.

alter table public.purchase_orders add column if not exists po_kind text not null default 'materials';
alter table public.purchase_orders drop constraint if exists purchase_orders_po_kind_check;
alter table public.purchase_orders add constraint purchase_orders_po_kind_check check (po_kind in ('materials', 'tools'));

alter table public.purchase_order_line_items
  add column if not exists is_tool boolean not null default false,
  add column if not exists tool_kind text;
alter table public.purchase_order_line_items drop constraint if exists purchase_order_line_items_tool_kind_check;
alter table public.purchase_order_line_items add constraint purchase_order_line_items_tool_kind_check check (tool_kind is null or tool_kind in ('tool', 'perishable'));
alter table public.purchase_order_line_items drop constraint if exists purchase_order_line_items_destination_type_check;
alter table public.purchase_order_line_items add constraint purchase_order_line_items_destination_type_check
  check (destination_type is null or destination_type in ('job', 'warehouse', 'vehicle', 'tools'));

create table if not exists public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'tool' check (kind in ('tool', 'perishable')),
  category text,
  serial_number text,
  quantity numeric not null default 1,
  purchase_date date,
  cost numeric not null default 0,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name text,
  bill_id uuid references public.supplier_bills(id) on delete set null,
  po_line_item_id uuid references public.purchase_order_line_items(id) on delete set null,
  bought_by uuid references public.profiles(id) on delete set null,
  location_type text not null default 'warehouse' check (location_type in ('warehouse', 'vehicle')),
  vehicle_id uuid references public.fleet_vehicles(id) on delete set null,
  status text not null default 'in_use' check (status in ('in_use', 'broken', 'replaced', 'lost', 'sold', 'written_off')),
  status_note text,
  status_changed_at timestamptz,
  status_changed_by uuid references public.profiles(id) on delete set null,
  warranty_expires date,
  test_tag_due date,
  photo_path text,
  receipt_path text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tools_supplier_id_idx on public.tools (supplier_id);
create index if not exists tools_bill_id_idx on public.tools (bill_id);
create index if not exists tools_po_line_item_id_idx on public.tools (po_line_item_id);
create index if not exists tools_bought_by_idx on public.tools (bought_by);
create index if not exists tools_vehicle_id_idx on public.tools (vehicle_id);
create index if not exists tools_status_changed_by_idx on public.tools (status_changed_by);
create index if not exists tools_created_by_idx on public.tools (created_by);
create index if not exists tools_kind_status_idx on public.tools (kind, status);

alter table public.tools enable row level security;
drop policy if exists "Everyone can view tools" on public.tools;
create policy "Everyone can view tools" on public.tools for select to authenticated using (true);
drop policy if exists "Pricing roles delete tools" on public.tools;
create policy "Pricing roles delete tools" on public.tools for delete to authenticated using ((select is_pricing_role()));

-- Lands a PO line (same as migration 20261101010000) plus destination 'tools': the line becomes tool
-- rows (one per tool, one row with the quantity for perishables) at the Warehouse or the vehicle.
create or replace function public._po_line_land(p_line uuid, p_dest text, p_job uuid, p_vehicle uuid, p_cost_centre uuid, p_first_receive boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_kind text;
  v_bill uuid;
  i integer;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
  select * into po from purchase_orders where id = li.po_id;
  if p_dest not in ('job', 'warehouse', 'vehicle', 'tools') then raise exception 'Pick where it goes.'; end if;
  if p_dest = 'job' and p_job is null then raise exception 'Pick the job.'; end if;
  if p_dest = 'vehicle' and p_vehicle is null then raise exception 'Pick the vehicle.'; end if;
  if p_dest = 'tools' and not (li.is_tool or po.po_kind = 'tools') then raise exception '% is not marked as a tool. Mark it first.', li.description; end if;
  if p_dest <> 'tools' and (li.is_tool or po.po_kind = 'tools') then raise exception '% is a tool: receive it to Tools (Warehouse or a vehicle).', li.description; end if;

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

-- Takes a received line back out (same as migration 20261101010000) plus tools: the rows it made go.
create or replace function public._po_line_take_back(p_line uuid, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  u record;
  v_left numeric := p_qty;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
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
    perform _stock_adjust(li.material_id, li.destination_type, li.destination_vehicle_id, -p_qty);
  elsif li.destination_type = 'tools' then
    if exists (select 1 from tools where po_line_item_id = li.id and status <> 'in_use') then
      raise exception '% is already marked broken, lost or sold in the Tools register, so it cannot be un-received.', li.description;
    end if;
    delete from tools where po_line_item_id = li.id;
  end if;
end;
$$;

-- Mark a PO line as a tool or perishable (or not). A line already received to a job or stock is taken
-- back out of there and landed in the register at the same place (vehicle or Warehouse).
create or replace function public.po_line_set_tool(p_line_id uuid, p_is_tool boolean, p_kind text default 'tool')
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_vehicle uuid;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can mark a line as a tool.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if p_is_tool and coalesce(p_kind, 'tool') not in ('tool', 'perishable') then raise exception 'Tool or perishable?'; end if;
  if li.received then
    v_vehicle := li.destination_vehicle_id;
    perform _po_line_take_back(li.id, li.quantity);
    update purchase_order_line_items set is_tool = p_is_tool, tool_kind = case when p_is_tool then coalesce(p_kind, 'tool') end, received = false where id = li.id;
    if p_is_tool then
      perform _po_line_land(li.id, 'tools', null, v_vehicle, null, false);
    else
      perform _po_line_land(li.id, case when po.project_id is not null then 'job' when v_vehicle is not null then 'vehicle' else 'warehouse' end, po.project_id, v_vehicle, po.cost_centre_id, false);
    end if;
  else
    update purchase_order_line_items set is_tool = p_is_tool, tool_kind = case when p_is_tool then coalesce(p_kind, 'tool') end where id = li.id;
  end if;
  perform _po_log('purchase_order', po.id, 'line_tool', format('%s x%s marked %s', li.description, _po_qty(li.quantity), case when p_is_tool then 'a ' || coalesce(p_kind, 'tool') || ' (goes to the Tools register, not the job or stock)' else 'not a tool' end));
  if po.project_id is not null then perform _po_log('project', po.project_id, 'po_line_tool', format('PO %s: %s marked %s', po.po_number, li.description, case when p_is_tool then 'a tool, off this job''s costs' else 'not a tool, costed to this job' end)); end if;
  perform _po_sync_received(po.id);
end;
$$;

-- Receive a line (same as migration 20261108000000) plus 'tools' with the vehicle it goes in.
create or replace function public.po_receive_line(p_line_id uuid, p_dest text, p_vehicle_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_job uuid;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  if li.received then raise exception 'Already received.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if po.closed_at is not null then raise exception 'PO % is closed. Ask Admin or Finance to reopen it first.', po.po_number; end if;
  if p_dest = 'job' and po.project_id is null then raise exception 'This PO is not for a job. Use Move to put it on one.'; end if;
  v_job := case when p_dest = 'job' then po.project_id end;

  perform _po_line_land(li.id, p_dest, v_job, p_vehicle_id, po.cost_centre_id, true);
  perform _po_log('purchase_order', po.id, 'item_received', format('%s x%s received - sent to %s', li.description, _po_qty(li.quantity),
    case when p_dest = 'tools' then 'Tools' || case when p_vehicle_id is not null then ' in ' || _po_place_label('vehicle', null, p_vehicle_id) else ' at the Warehouse' end else _po_place_label(p_dest, v_job, p_vehicle_id) end));
  if p_dest = 'job' then
    perform _po_log('project', v_job, 'material_received', format('%s x%s received from PO %s, costed to this job', li.description, _po_qty(li.quantity), po.po_number));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

-- A tool bought outside a PO (a receipt from the counter). Any role.
create or replace function public.tool_create(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_kind text := coalesce(nullif(p->>'kind', ''), 'tool');
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if nullif(trim(coalesce(p->>'name', '')), '') is null then raise exception 'What is it?'; end if;
  if v_kind not in ('tool', 'perishable') then raise exception 'Tool or perishable?'; end if;
  if coalesce(p->>'location_type', 'warehouse') = 'vehicle' and nullif(p->>'vehicle_id', '') is null then raise exception 'Pick the vehicle.'; end if;
  insert into tools (name, kind, category, serial_number, quantity, purchase_date, cost, supplier_id, supplier_name, bill_id, bought_by, location_type, vehicle_id,
      warranty_expires, test_tag_due, photo_path, receipt_path, notes, created_by)
  values (trim(p->>'name'), v_kind, nullif(trim(coalesce(p->>'category', '')), ''), nullif(trim(coalesce(p->>'serial_number', '')), ''),
      coalesce(nullif(p->>'quantity', '')::numeric, 1), nullif(p->>'purchase_date', '')::date, coalesce(nullif(p->>'cost', '')::numeric, 0),
      nullif(p->>'supplier_id', '')::uuid, nullif(trim(coalesce(p->>'supplier_name', '')), ''), nullif(p->>'bill_id', '')::uuid, auth.uid(),
      coalesce(nullif(p->>'location_type', ''), 'warehouse'), case when coalesce(p->>'location_type', 'warehouse') = 'vehicle' then (p->>'vehicle_id')::uuid end,
      nullif(p->>'warranty_expires', '')::date, nullif(p->>'test_tag_due', '')::date, nullif(p->>'photo_path', ''), nullif(p->>'receipt_path', ''), nullif(trim(coalesce(p->>'notes', '')), ''), auth.uid())
  returning id into v_id;
  perform _po_log('tool', v_id, 'created', format('%s added to the Tools register%s', trim(p->>'name'), case when coalesce(nullif(p->>'cost', '')::numeric, 0) > 0 then ' ($' || to_char((p->>'cost')::numeric, 'FM999G999G990D00') || ')' else '' end));
  return v_id;
end;
$$;

-- Change a tool: where it is, its status (with a note), serial, photo, receipt, dates, notes. Any role; logged.
create or replace function public.tool_update(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  t tools;
  v_changes text[] := '{}';
  v_status text;
  v_loc text;
  v_vehicle uuid;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  select * into t from tools where id = p_id for update;
  if not found then raise exception 'Tool not found.'; end if;
  if p ? 'status' then
    v_status := p->>'status';
    if v_status not in ('in_use', 'broken', 'replaced', 'lost', 'sold', 'written_off') then raise exception 'Unknown status.'; end if;
    if v_status is distinct from t.status then
      v_changes := v_changes || format('status %s to %s%s', replace(t.status, '_', ' '), replace(v_status, '_', ' '), coalesce(': ' || nullif(trim(coalesce(p->>'status_note', '')), ''), ''));
      update tools set status = v_status, status_note = nullif(trim(coalesce(p->>'status_note', '')), ''), status_changed_at = now(), status_changed_by = auth.uid() where id = t.id;
    end if;
  end if;
  if p ? 'location_type' then
    v_loc := coalesce(nullif(p->>'location_type', ''), 'warehouse');
    v_vehicle := case when v_loc = 'vehicle' then nullif(p->>'vehicle_id', '')::uuid end;
    if v_loc = 'vehicle' and v_vehicle is null then raise exception 'Pick the vehicle.'; end if;
    if v_loc is distinct from t.location_type or v_vehicle is distinct from t.vehicle_id then
      v_changes := v_changes || format('moved from %s to %s', _po_place_label(t.location_type, null, t.vehicle_id), _po_place_label(v_loc, null, v_vehicle));
      update tools set location_type = v_loc, vehicle_id = v_vehicle where id = t.id;
    end if;
  end if;
  update tools set
    name = coalesce(nullif(trim(coalesce(p->>'name', '')), ''), name),
    kind = case when p->>'kind' in ('tool', 'perishable') then p->>'kind' else kind end,
    category = case when p ? 'category' then nullif(trim(coalesce(p->>'category', '')), '') else category end,
    serial_number = case when p ? 'serial_number' then nullif(trim(coalesce(p->>'serial_number', '')), '') else serial_number end,
    quantity = case when p ? 'quantity' then coalesce(nullif(p->>'quantity', '')::numeric, quantity) else quantity end,
    purchase_date = case when p ? 'purchase_date' then nullif(p->>'purchase_date', '')::date else purchase_date end,
    cost = case when p ? 'cost' and is_pricing_role() then coalesce(nullif(p->>'cost', '')::numeric, cost) else cost end,
    supplier_id = case when p ? 'supplier_id' then nullif(p->>'supplier_id', '')::uuid else supplier_id end,
    supplier_name = case when p ? 'supplier_name' then nullif(trim(coalesce(p->>'supplier_name', '')), '') else supplier_name end,
    warranty_expires = case when p ? 'warranty_expires' then nullif(p->>'warranty_expires', '')::date else warranty_expires end,
    test_tag_due = case when p ? 'test_tag_due' then nullif(p->>'test_tag_due', '')::date else test_tag_due end,
    photo_path = case when p ? 'photo_path' then nullif(p->>'photo_path', '') else photo_path end,
    receipt_path = case when p ? 'receipt_path' then nullif(p->>'receipt_path', '') else receipt_path end,
    notes = case when p ? 'notes' then nullif(trim(coalesce(p->>'notes', '')), '') else notes end,
    updated_at = now()
  where id = t.id;
  if p ? 'serial_number' and nullif(trim(coalesce(p->>'serial_number', '')), '') is distinct from t.serial_number then v_changes := v_changes || 'serial number set'::text; end if;
  if p ? 'photo_path' and nullif(p->>'photo_path', '') is distinct from t.photo_path then v_changes := v_changes || 'photo added'::text; end if;
  if p ? 'receipt_path' and nullif(p->>'receipt_path', '') is distinct from t.receipt_path then v_changes := v_changes || 'receipt added'::text; end if;
  if cardinality(v_changes) > 0 then
    perform _po_log('tool', t.id, 'updated', format('%s: %s', t.name, array_to_string(v_changes, ', ')));
  end if;
end;
$$;

revoke all on function public._po_line_land(uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public._po_line_take_back(uuid, numeric) from public, anon, authenticated;
revoke all on function public.po_line_set_tool(uuid, boolean, text) from public, anon;
revoke all on function public.po_receive_line(uuid, text, uuid) from public, anon;
revoke all on function public.tool_create(jsonb) from public, anon;
revoke all on function public.tool_update(uuid, jsonb) from public, anon;
grant execute on function public.po_line_set_tool(uuid, boolean, text) to authenticated;
grant execute on function public.po_receive_line(uuid, text, uuid) to authenticated;
grant execute on function public.tool_create(jsonb) to authenticated;
grant execute on function public.tool_update(uuid, jsonb) to authenticated;
