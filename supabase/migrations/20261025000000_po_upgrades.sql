-- Purchase order upgrades (docs/IDEAS_BACKLOG.md item 10, PROJECT_SPEC A10):
--  * Stock PO on a job: pull gear from the Warehouse or a vehicle and correct the count on the spot.
--  * Receiving on a job PO only goes to its own job; Move is the deliberate way to another job.
--  * Move unused lines (all or part) to another job, the Warehouse or a vehicle.
--  * Undo received (note needed once the PO is closed or a bill on it is approved), or switch to back ordered.
--  * Open / Closed POs: closed = nothing added or repriced, approved for payment. Admin/Finance reopen with a note.
--  * PO page and PDF by token (po.html, generate-client-document-pdf doc_type 'po').
-- Every change runs in one security definer step so it is all or nothing and works for every role
-- (staff cannot write job_material_usage or update PO lines directly).

alter table public.purchase_orders
  add column if not exists stock_source text,
  add column if not exists stock_source_vehicle_id uuid references public.fleet_vehicles(id),
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references public.profiles(id),
  add column if not exists po_token uuid default gen_random_uuid(),
  add column if not exists pdf_path text,
  add column if not exists pdf_generated_at timestamptz;

update public.purchase_orders set po_token = gen_random_uuid() where po_token is null;
alter table public.purchase_orders alter column po_token set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_stock_source_check') then
    alter table public.purchase_orders add constraint purchase_orders_stock_source_check check (stock_source in ('warehouse', 'vehicle'));
  end if;
end $$;

create unique index if not exists purchase_orders_po_token_uq on public.purchase_orders (po_token);
create index if not exists purchase_orders_stock_source_vehicle_id_idx on public.purchase_orders (stock_source_vehicle_id);
create index if not exists purchase_orders_closed_by_idx on public.purchase_orders (closed_by);
create index if not exists purchase_order_line_items_destination_job_id_idx on public.purchase_order_line_items (destination_job_id);
create index if not exists job_material_usage_po_line_item_id_idx on public.job_material_usage (po_line_item_id);

-- Existing POs: fully received or approved become Closed (and approved), the rest Open.
update public.purchase_orders
  set closed_at = coalesce(received_at, approved_at, created_at),
      closed_by = coalesce(received_by, approved_by),
      locked = true,
      approved_for_payment = true
  where (received or approved_for_payment) and closed_at is null;
update public.purchase_orders set locked = false where closed_at is null;

-- ---------- helpers (not callable from the app) ----------

create or replace function public._po_log(p_type text, p_id uuid, p_action text, p_text text)
returns void language sql security definer set search_path = public as $$
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values (p_type, p_id, p_action, p_text, auth.uid());
$$;

create or replace function public._po_qty(n numeric)
returns text language sql immutable as $$
  select trim(trailing '.' from trim(trailing '0' from round(n, 2)::text));
$$;

create or replace function public._po_job_ref(p_project_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce('J' || job_number, name) from projects where id = p_project_id;
$$;

create or replace function public._po_place_label(p_type text, p_job uuid, p_vehicle uuid)
returns text language sql stable security definer set search_path = public as $$
  select case p_type
    when 'job' then coalesce(_po_job_ref(p_job), 'a job')
    when 'vehicle' then coalesce((select coalesce(vehicle_name, rego) from fleet_vehicles where id = p_vehicle), 'a vehicle')
    else 'Warehouse' end;
$$;

-- Adds p_delta (can be negative) to a stock location. Never goes below zero: a shortfall raises,
-- naming what the app has there, unless p_allow_short (then it stops at zero).
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
  return v_new;
end;
$$;

-- Lands a not-yet-received line at a place and marks it received. p_first_receive: a vehicle PO with
-- no supplier (old "pull from Warehouse to a vehicle") takes it out of the Warehouse on its first receive.
create or replace function public._po_line_land(p_line uuid, p_dest text, p_job uuid, p_vehicle uuid, p_cost_centre uuid, p_first_receive boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
  select * into po from purchase_orders where id = li.po_id;
  if p_dest not in ('job', 'warehouse', 'vehicle') then raise exception 'Pick where it goes.'; end if;
  if p_dest = 'job' and p_job is null then raise exception 'Pick the job.'; end if;
  if p_dest = 'vehicle' and p_vehicle is null then raise exception 'Pick the vehicle.'; end if;

  if p_dest = 'job' then
    insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, po_line_item_id, created_by)
    values (p_job, p_cost_centre, li.material_id, li.quantity, li.unit_cost,
            case when po.stock_source is not null then 'from_stock' else 'from_po' end, li.id, auth.uid());
  else
    if p_first_receive and p_dest = 'vehicle' and po.vehicle_id is not null and po.supplier_id is null and po.stock_source is null then
      perform _stock_adjust(li.material_id, 'warehouse', null, -li.quantity);
    end if;
    perform _stock_adjust(li.material_id, p_dest, p_vehicle, li.quantity);
  end if;

  update purchase_order_line_items set
    received = true, destination_type = p_dest,
    destination_job_id = case when p_dest = 'job' then p_job end,
    destination_vehicle_id = case when p_dest = 'vehicle' then p_vehicle end,
    received_by = auth.uid(), received_at = now(),
    is_backordered = false, backorder_eta = null
  where id = li.id;
end;
$$;

-- Takes p_qty of a received line back out of wherever it landed (off the job's costs, or out of the
-- Warehouse / vehicle count). Refuses if the job has invoiced it, or the stock is no longer there.
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
  elsif li.destination_type in ('warehouse', 'vehicle') then
    perform _stock_adjust(li.material_id, li.destination_type, li.destination_vehicle_id, -p_qty);
  end if;
end;
$$;

-- Keeps purchase_orders.received in step with its lines. Becoming fully received approves the bills
-- that match it (as before), never for a supplier still marked "New, check details".
create or replace function public._po_sync_received(p_po uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  po purchase_orders;
  v_all boolean;
begin
  select * into po from purchase_orders where id = p_po for update;
  select coalesce(bool_and(received), false) into v_all from purchase_order_line_items where po_id = p_po;
  if v_all and not po.received then
    update purchase_orders set received = true, received_by = auth.uid(), received_at = now() where id = p_po;
    perform _po_approve_bills(p_po);
    perform _po_log('purchase_order', p_po, 'fully_received', format('PO %s fully received - linked bills that match it approved for payment', po.po_number));
  elsif not v_all and po.received then
    update purchase_orders set received = false, received_by = null, received_at = null where id = p_po;
  end if;
end;
$$;

create or replace function public._po_approve_bills(p_po uuid)
returns void language plpgsql security definer set search_path = public as $$
declare po purchase_orders;
begin
  select * into po from purchase_orders where id = p_po;
  if po.supplier_id is not null and exists (select 1 from suppliers where id = po.supplier_id and needs_review) then return; end if;
  update supplier_bills set approved_for_payment = true
    where po_id = p_po and check_status in ('matches', 'resolved') and not approved_for_payment;
end;
$$;

-- A closed PO takes no new lines and no quantity or price changes, except through the steps below.
create or replace function public.po_line_closed_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_po uuid; v_num text;
begin
  if coalesce(current_setting('teops.po_step', true), '') = 'on' then return new; end if;
  if tg_op = 'UPDATE' and new.po_id is not distinct from old.po_id and new.quantity is not distinct from old.quantity
     and new.unit_cost is not distinct from old.unit_cost then return new; end if;
  v_po := new.po_id;
  select po_number into v_num from purchase_orders where id = v_po and closed_at is not null;
  if found then raise exception 'PO % is closed. Ask Admin or Finance to reopen it first.', v_num; end if;
  return new;
end;
$$;

drop trigger if exists trg_po_line_closed_guard on public.purchase_order_line_items;
create trigger trg_po_line_closed_guard before insert or update on public.purchase_order_line_items
  for each row execute function public.po_line_closed_guard();

-- ---------- steps the app calls ----------

-- Receive a line. On a job PO "job" always means the PO's own job (Move is for another job).
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
  if p_dest = 'job' and po.project_id is null then raise exception 'This PO is not for a job. Use Move to put it on one.'; end if;
  v_job := case when p_dest = 'job' then po.project_id end;

  perform _po_line_land(li.id, p_dest, v_job, p_vehicle_id, po.cost_centre_id, true);
  perform _po_log('purchase_order', po.id, 'item_received', format('%s x%s received - sent to %s', li.description, _po_qty(li.quantity), _po_place_label(p_dest, v_job, p_vehicle_id)));
  if p_dest = 'job' then
    perform _po_log('project', v_job, 'material_received', format('%s x%s received from PO %s, costed to this job', li.description, _po_qty(li.quantity), po.po_number));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

-- Undo received: puts back what receiving did. Needs a note once the PO is closed or a bill on it is
-- approved for payment. p_backorder: it was meant to be marked back ordered.
create or replace function public.po_undo_receive(p_line_id uuid, p_note text default null, p_backorder boolean default false, p_eta date default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_from text;
  v_text text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  if not li.received then raise exception 'That line is not received.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if (po.closed_at is not null or po.approved_for_payment
      or exists (select 1 from supplier_bills where po_id = po.id and approved_for_payment))
     and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'This PO is approved for payment. Add a note saying why it is not received.';
  end if;

  v_from := _po_place_label(li.destination_type, li.destination_job_id, li.destination_vehicle_id);
  perform _po_line_take_back(li.id, li.quantity);
  -- a stock PO's gear goes back where it was pulled from; so does an old Warehouse-to-vehicle pull
  if po.stock_source is not null then
    perform _stock_adjust(li.material_id, po.stock_source, po.stock_source_vehicle_id, li.quantity);
  elsif li.destination_type = 'vehicle' and po.vehicle_id is not null and po.supplier_id is null then
    perform _stock_adjust(li.material_id, 'warehouse', null, li.quantity);
  end if;

  update purchase_order_line_items set
    received = false, destination_type = null, destination_job_id = null, destination_vehicle_id = null,
    received_by = null, received_at = null,
    is_backordered = coalesce(p_backorder, false), backorder_eta = case when p_backorder then p_eta end
  where id = li.id;

  v_text := format('%s x%s no longer received (was at %s)%s%s', li.description, _po_qty(li.quantity), v_from,
    case when p_backorder then ', marked back ordered' || coalesce(' - ETA ' || to_char(p_eta, 'DD Mon'), '') else '' end,
    coalesce(': ' || nullif(trim(p_note), ''), ''));
  perform _po_log('purchase_order', po.id, 'item_unreceived', v_text);
  if li.destination_type = 'job' then
    perform _po_log('project', li.destination_job_id, 'material_unreceived', format('PO %s: %s', po.po_number, v_text));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

-- Move all or part of a line to another job, the Warehouse or a vehicle. Received: it comes out of
-- where it is first. Not received yet: it is received straight to the new place. Part splits the line.
create or replace function public.po_move_line(p_line_id uuid, p_qty numeric, p_dest text, p_job_id uuid default null, p_vehicle_id uuid default null, p_cost_centre_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_target uuid;
  v_from text;
  v_to text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if p_qty is null or p_qty <= 0 or p_qty > li.quantity then
    raise exception 'Move between 1 and % of these.', _po_qty(li.quantity);
  end if;
  if li.received and li.destination_type = p_dest
     and ((p_dest = 'job' and li.destination_job_id = p_job_id) or (p_dest = 'vehicle' and li.destination_vehicle_id = p_vehicle_id) or p_dest = 'warehouse') then
    raise exception 'It is already there.';
  end if;
  if p_dest = 'job' and p_cost_centre_id is not null
     and not exists (select 1 from cost_centres where id = p_cost_centre_id and project_id = p_job_id) then
    raise exception 'That stage is not on the job picked.';
  end if;

  v_from := case when li.received then _po_place_label(li.destination_type, li.destination_job_id, li.destination_vehicle_id) else 'not received' end;
  v_to := _po_place_label(p_dest, p_job_id, p_vehicle_id);

  if li.received then perform _po_line_take_back(li.id, p_qty); end if;

  if p_qty < li.quantity then
    insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
    values (li.po_id, li.material_id, li.description, p_qty, li.unit_cost, auth.uid())
    returning id into v_target;
    update purchase_order_line_items set quantity = quantity - p_qty where id = li.id;
  else
    v_target := li.id;
    update purchase_order_line_items set received = false where id = li.id;
  end if;

  perform _po_line_land(v_target, p_dest, p_job_id, p_vehicle_id,
    case when p_dest = 'job' then coalesce(p_cost_centre_id, case when p_job_id = po.project_id then po.cost_centre_id end) end,
    not li.received);

  perform _po_log('purchase_order', po.id, 'item_moved', format('%s x%s moved from %s to %s', li.description, _po_qty(p_qty), v_from, v_to));
  if li.received and li.destination_type = 'job' then
    perform _po_log('project', li.destination_job_id, 'material_moved', format('PO %s: %s x%s moved off this job to %s', po.po_number, li.description, _po_qty(p_qty), v_to));
  end if;
  if p_dest = 'job' then
    perform _po_log('project', p_job_id, 'material_moved', format('PO %s: %s x%s moved onto this job from %s', po.po_number, li.description, _po_qty(p_qty), v_from));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

-- Stock PO on a job: takes the gear out of the Warehouse or a vehicle, sets the real count when the
-- person says how many are left, costs it to the job and closes the PO.
-- p_lines: [{ "material_id": uuid, "quantity": n, "left_after": n or null }]
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
  v_summary text[] := '{}';
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
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item from Stock.'; end if;
  v_place := _po_place_label(p_source, null, p_vehicle_id);

  update company_settings set next_po_number = next_po_number + 1 where id = 1
    returning coalesce(nullif(po_number_prefix, ''), 'PO') || (next_po_number - 1) into v_num;

  insert into purchase_orders (project_id, cost_centre_id, supplier_id, supplier_name, po_number, description,
      po_type, locked, status, amount, received, received_by, received_at, closed_at, closed_by,
      approved_for_payment, approved_by, approved_at, stock_source, stock_source_vehicle_id)
  values (p_project_id, p_cost_centre_id, null, v_place, v_num, coalesce(nullif(trim(p_description), ''), 'Stock pulled from ' || v_place),
      'fixed', true, 'received', 0, true, auth.uid(), now(), now(), auth.uid(),
      true, auth.uid(), now(), p_source, case when p_source = 'vehicle' then p_vehicle_id end)
  returning id into v_po;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into m from materials where id = (v_line->>'material_id')::uuid;
    if not found then raise exception 'Pick each item from Stock.'; end if;
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
    values (v_po, m.id, m.name, v_qty, m.cost_price, auth.uid(), true, 'job', p_project_id, auth.uid(), now())
    returning id into v_li;
    insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, po_line_item_id, created_by)
    values (p_project_id, p_cost_centre_id, m.id, v_qty, m.cost_price, 'from_stock', v_li, auth.uid());
    v_summary := v_summary || format('%s x %s', _po_qty(v_qty), m.name);
  end loop;

  perform _po_log('purchase_order', v_po, 'created', format('Stock PO %s: pulled %s from %s for %s', v_num, array_to_string(v_summary, ', '), v_place, _po_job_ref(p_project_id)));
  perform _po_log('project', p_project_id, 'po_created', format('Stock PO %s: pulled %s from %s', v_num, array_to_string(v_summary, ', '), v_place));
  return jsonb_build_object('id', v_po, 'po_number', v_num);
end;
$$;

-- Close (anyone): nothing more added, PO and its matching bills approved for payment.
-- Reopen (Admin / Finance only, note required).
create or replace function public.po_set_closed(p_po_id uuid, p_closed boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare po purchase_orders;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  select * into po from purchase_orders where id = p_po_id for update;
  if not found then raise exception 'PO not found.'; end if;
  if p_closed then
    if po.closed_at is not null then return; end if;
    update purchase_orders set closed_at = now(), closed_by = auth.uid(), locked = true,
      approved_for_payment = true, approved_by = auth.uid(), approved_at = now()
      where id = po.id;
    perform _po_approve_bills(po.id);
    perform _po_log('purchase_order', po.id, 'closed', format('PO %s closed and approved for payment%s', po.po_number, coalesce(': ' || nullif(trim(p_note), ''), '')));
    if po.project_id is not null then perform _po_log('project', po.project_id, 'po_closed', format('PO %s closed and approved for payment', po.po_number)); end if;
  else
    if not is_finance_role() then raise exception 'Only Admin or Finance can reopen a closed PO.'; end if;
    if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'Add a note saying why it is being reopened.'; end if;
    if po.closed_at is null then return; end if;
    update purchase_orders set closed_at = null, closed_by = null, locked = false,
      approved_for_payment = false, approved_by = null, approved_at = null
      where id = po.id;
    perform _po_log('purchase_order', po.id, 'reopened', format('PO %s reopened: %s', po.po_number, trim(p_note)));
    if po.project_id is not null then perform _po_log('project', po.project_id, 'po_reopened', format('PO %s reopened: %s', po.po_number, trim(p_note))); end if;
  end if;
end;
$$;

-- What po.html shows the supplier (anyone with the link, like an invoice).
create or replace function public.get_po_by_token(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'po', jsonb_build_object('po_number', po.po_number, 'order_date', po.order_date, 'description', po.description,
      'supplier_name', coalesce(s.name, po.supplier_name), 'closed', po.closed_at is not null),
    'deliver', case
      when po.project_id is not null then jsonb_build_object('job_number', p.job_number, 'job_name', p.name, 'address', p.client_address)
      when po.vehicle_id is not null then jsonb_build_object('label', coalesce(v.vehicle_name, v.rego))
      else jsonb_build_object('label', 'Warehouse') end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.created_at, li.id)
                       from purchase_order_line_items li where li.po_id = po.id), '[]'::jsonb),
    'company', (select jsonb_build_object('company_name', company_name, 'abn', abn, 'address', address, 'phone', phone,
                       'website', website, 'licenses', licenses, 'logo_url', logo_url) from company_settings where id = 1))
  from purchase_orders po
  left join suppliers s on s.id = po.supplier_id
  left join projects p on p.id = po.project_id
  left join fleet_vehicles v on v.id = po.vehicle_id
  where po.po_token = p_token;
$$;

revoke all on function public._po_log(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public._po_job_ref(uuid) from public, anon, authenticated;
revoke all on function public._po_place_label(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public._stock_adjust(uuid, text, uuid, numeric, boolean) from public, anon, authenticated;
revoke all on function public._po_line_land(uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public._po_line_take_back(uuid, numeric) from public, anon, authenticated;
revoke all on function public._po_sync_received(uuid) from public, anon, authenticated;
revoke all on function public._po_approve_bills(uuid) from public, anon, authenticated;
revoke all on function public.po_line_closed_guard() from public, anon, authenticated;
revoke all on function public.po_receive_line(uuid, text, uuid) from public, anon;
revoke all on function public.po_undo_receive(uuid, text, boolean, date) from public, anon;
revoke all on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) from public, anon;
revoke all on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) from public, anon;
revoke all on function public.po_set_closed(uuid, boolean, text) from public, anon;
grant execute on function public.po_receive_line(uuid, text, uuid) to authenticated;
grant execute on function public.po_undo_receive(uuid, text, boolean, date) to authenticated;
grant execute on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) to authenticated;
grant execute on function public.po_create_stock_pull(uuid, uuid, text, uuid, jsonb, text) to authenticated;
grant execute on function public.po_set_closed(uuid, boolean, text) to authenticated;
grant execute on function public.get_po_by_token(uuid) to anon, authenticated;
