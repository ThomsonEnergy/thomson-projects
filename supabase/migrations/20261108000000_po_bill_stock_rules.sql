-- PO, supplier bill and stock rules (docs/PO_REVIEW.md, Delivery 1: P1 to P16, P18).
--
--  * PO status is kept by the database: ordered / part_received / received / closed, and
--    purchase_orders.received follows the lines on every line change (trigger), not only the po_ steps.
--  * Close is the approval step: a PO closes only when every line is received, back ordered (the closer
--    picks: wait, or close now and cancel them off the PO) or moved off. Closing approves its matched
--    bills and sets their pay-on date. Bills are no longer approved just because every line is received.
--    Nothing is received or moved on a closed PO; Undo received on a closed PO reopens it (Admin/Finance,
--    note) and un-approves its unpaid bills.
--  * Pay-on date (supplier_bills.pay_on): the later of the supplier's terms date and the day we approved.
--    Overdue on the supplier pages means approved and past pay_on. Paid bills record who, when and the
--    reference (supplier_payments row per supplier per batch).
--  * A reviewed bill is saved by one server step (supplier_bill_save_review): duplicate check by
--    normalised bill number, optional new PO, lines linked or flagged. It never touches stock: stock moves
--    when the PO line is received.
--  * Every stock count change goes through stock_set_count (locked, logged with who and why) or the po_
--    steps; browser writes to material_stock_by_location are closed off. Variation materials from Stock
--    come off the shelf in one step (variation_material_add).
--  * Staff can create and edit POs but only pricing roles change the money, the job, the supplier or the
--    state (trigger); only pricing roles delete a PO; a received line cannot be deleted (Undo first).
--  * order_date defaults to the Sydney date.

-- ---------- columns ----------

alter table public.supplier_bills
  add column if not exists pay_on date,
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references public.profiles(id) on delete set null,
  add column if not exists payment_reference text;
create index if not exists supplier_bills_paid_by_idx on public.supplier_bills (paid_by);
create index if not exists supplier_bills_payment_id_idx on public.supplier_bills (payment_id);
create index if not exists supplier_bills_pay_on_idx on public.supplier_bills (pay_on);

alter table public.supplier_payments
  add column if not exists paid_on date,
  add column if not exists reference text,
  add column if not exists bill_count integer not null default 0,
  add column if not exists notes text;
create index if not exists supplier_payments_initiated_by_idx on public.supplier_payments (initiated_by);

alter table public.purchase_orders alter column order_date set default public.sydney_today();

alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in ('ordered', 'part_received', 'received', 'closed'));

-- ---------- helpers ----------

-- INV-0103, inv103 and INV 103 are the same bill number (same rule as _shared/bill-check.js)
create or replace function public._bill_num_norm(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '^(inv|invoice)', ''), '^0+', ''), '');
$$;

-- Keeps purchase_orders.received and status in step with the lines. No longer approves bills: Close does.
create or replace function public._po_sync_received(p_po uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  po purchase_orders;
  v_total integer;
  v_recv integer;
  v_all boolean;
  v_status text;
begin
  select * into po from purchase_orders where id = p_po for update;
  if not found then return; end if;
  perform set_config('teops.po_step', 'on', true);
  select count(*), count(*) filter (where received) into v_total, v_recv from purchase_order_line_items where po_id = p_po;
  v_all := v_total > 0 and v_recv = v_total;
  v_status := case when po.closed_at is not null then 'closed' when v_all then 'received' when v_recv > 0 then 'part_received' else 'ordered' end;
  if v_all and not po.received then
    update purchase_orders set received = true, received_by = auth.uid(), received_at = now(), status = v_status where id = p_po;
    if po.closed_at is null then
      perform _po_log('purchase_order', p_po, 'fully_received', format('PO %s: every line received. Close it to approve its bills for payment.', po.po_number));
    end if;
  elsif not v_all and po.received then
    update purchase_orders set received = false, received_by = null, received_at = null, status = v_status where id = p_po;
  elsif po.status is distinct from v_status then
    update purchase_orders set status = v_status where id = p_po;
  end if;
end;
$$;

-- Any line change (+ Add item, Edit lines, a line removed, the po_ steps) keeps the PO in step.
create or replace function public.po_lines_sync_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform _po_sync_received(new.po_id); end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.po_id is distinct from new.po_id) then perform _po_sync_received(old.po_id); end if;
  return null;
end;
$$;

drop trigger if exists trg_po_lines_sync_status on public.purchase_order_line_items;
create trigger trg_po_lines_sync_status after insert or update or delete on public.purchase_order_line_items
  for each row execute function public.po_lines_sync_status();

-- A received line is never deleted from the browser: Undo received first (its job cost or stock would be left behind).
create or replace function public.po_line_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('teops.po_step', true), '') = 'on' then return old; end if;
  if old.received then raise exception '% is received. Undo received before removing it from the PO.', old.description; end if;
  return old;
end;
$$;

drop trigger if exists trg_po_line_delete_guard on public.purchase_order_line_items;
create trigger trg_po_line_delete_guard before delete on public.purchase_order_line_items
  for each row execute function public.po_line_delete_guard();

-- Staff can edit a PO's notes, description and prices toggle; the money, the job, the supplier and the
-- state are pricing roles only (the po_ steps and the server set them with teops.po_step on).
create or replace function public.purchase_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('teops.po_step', true), '') = 'on' then return new; end if;
  if auth.uid() is null or is_pricing_role() then return new; end if;
  if new.amount is distinct from old.amount or new.budget_cap is distinct from old.budget_cap
     or new.supplier_id is distinct from old.supplier_id or new.supplier_name is distinct from old.supplier_name
     or new.project_id is distinct from old.project_id or new.cost_centre_id is distinct from old.cost_centre_id
     or new.vehicle_id is distinct from old.vehicle_id or new.po_number is distinct from old.po_number
     or new.po_type is distinct from old.po_type or new.locked is distinct from old.locked
     or new.status is distinct from old.status or new.received is distinct from old.received
     or new.received_by is distinct from old.received_by or new.received_at is distinct from old.received_at
     or new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by
     or new.approved_for_payment is distinct from old.approved_for_payment or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at or new.stock_source is distinct from old.stock_source
     or new.stock_source_vehicle_id is distinct from old.stock_source_vehicle_id or new.po_token is distinct from old.po_token then
    raise exception 'Only Admin, Finance or Sales can change that on a PO.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_purchase_orders_guard on public.purchase_orders;
create trigger trg_purchase_orders_guard before update on public.purchase_orders
  for each row execute function public.purchase_orders_guard();

-- Approves the bills on a PO that match it (or were accepted), never for a "New, check details" supplier.
-- Pay on = the later of the supplier's terms date and today.
create or replace function public._po_approve_bills(p_po uuid)
returns void language plpgsql security definer set search_path = public as $$
declare po purchase_orders;
begin
  select * into po from purchase_orders where id = p_po;
  if po.supplier_id is not null and exists (select 1 from suppliers where id = po.supplier_id and needs_review) then return; end if;
  update supplier_bills set approved_for_payment = true, approved_by = auth.uid(), approved_at = now(),
      pay_on = greatest(coalesce(due_date, sydney_today()), sydney_today())
    where po_id = p_po and check_status in ('matches', 'resolved') and not approved_for_payment and not paid;
end;
$$;

-- ---------- steps the app calls ----------

-- Receive a line. Refused on a closed PO.
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
  perform _po_log('purchase_order', po.id, 'item_received', format('%s x%s received - sent to %s', li.description, _po_qty(li.quantity), _po_place_label(p_dest, v_job, p_vehicle_id)));
  if p_dest = 'job' then
    perform _po_log('project', v_job, 'material_received', format('%s x%s received from PO %s, costed to this job', li.description, _po_qty(li.quantity), po.po_number));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

-- Move all or part of a line. Refused on a closed PO.
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
  if po.closed_at is not null then raise exception 'PO % is closed. Ask Admin or Finance to reopen it first.', po.po_number; end if;
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

-- Undo received. On a closed PO this reopens it (Admin / Finance, note needed) and un-approves its unpaid bills.
create or replace function public.po_undo_receive(p_line_id uuid, p_note text default null, p_backorder boolean default false, p_eta date default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
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

-- Close: every line received, back ordered (p_cancel_backorders: close now and take them off the PO) or
-- moved off. Closing approves the PO and its matching bills. Reopen: Admin / Finance, note required, and
-- its unpaid bills are no longer approved.
drop function if exists public.po_set_closed(uuid, boolean, text);
create or replace function public.po_set_closed(p_po_id uuid, p_closed boolean, p_note text default null, p_cancel_backorders boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  po purchase_orders;
  v_open text;
  v_bo text;
  v_bo_n integer;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into po from purchase_orders where id = p_po_id for update;
  if not found then raise exception 'PO not found.'; end if;
  if p_closed then
    if po.closed_at is not null then return; end if;
    select string_agg(description || ' x' || _po_qty(quantity), ', ' order by created_at) into v_open
      from purchase_order_line_items where po_id = po.id and not received and not is_backordered;
    if v_open is not null then
      raise exception 'Not received yet: %. Receive it, mark it back ordered, or move it off the PO before closing.', v_open;
    end if;
    select count(*), string_agg(description || ' x' || _po_qty(quantity), ', ' order by created_at) into v_bo_n, v_bo
      from purchase_order_line_items where po_id = po.id and not received and is_backordered;
    if v_bo_n > 0 then
      if not coalesce(p_cancel_backorders, false) then
        raise exception 'Back ordered: %. Wait for it, or close now and cancel it off the PO.', v_bo;
      end if;
      delete from purchase_order_line_items where po_id = po.id and not received and is_backordered;
      perform _po_log('purchase_order', po.id, 'backorders_cancelled', format('Back ordered lines cancelled off PO %s at close: %s', po.po_number, v_bo));
      if po.project_id is not null then perform _po_log('project', po.project_id, 'po_backorders_cancelled', format('PO %s: back ordered lines cancelled at close: %s', po.po_number, v_bo)); end if;
    end if;
    update purchase_orders set closed_at = now(), closed_by = auth.uid(), locked = true, status = 'closed',
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
    update supplier_bills set approved_for_payment = false, approved_by = null, approved_at = null, pay_on = null
      where po_id = po.id and not paid and approved_for_payment;
    perform _po_sync_received(po.id);
    perform _po_log('purchase_order', po.id, 'reopened', format('PO %s reopened: %s', po.po_number, trim(p_note)));
    if po.project_id is not null then perform _po_log('project', po.project_id, 'po_reopened', format('PO %s reopened: %s', po.po_number, trim(p_note))); end if;
  end if;
end;
$$;

-- Set the count of one item at one place (Warehouse or a vehicle), locked and logged on the item with
-- who and why. The only way a count is changed by hand.
create or replace function public.stock_set_count(p_material_id uuid, p_loc text, p_vehicle_id uuid, p_new numeric, p_reason text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  m materials;
  v_have numeric;
  v_place text;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_loc not in ('warehouse', 'vehicle') then raise exception 'Pick Warehouse or a vehicle.'; end if;
  if p_loc = 'vehicle' and not exists (select 1 from fleet_vehicles where id = p_vehicle_id and holds_stock) then raise exception 'Pick the vehicle.'; end if;
  if p_new is null or p_new < 0 then raise exception 'The count cannot be below 0.'; end if;
  select * into m from materials where id = p_material_id for update;
  if not found then raise exception 'Stock item not found.'; end if;
  select coalesce(sum(quantity), 0) into v_have from material_stock_by_location
    where material_id = m.id and location_type = p_loc and (p_loc = 'warehouse' or vehicle_id = p_vehicle_id);
  if p_new = v_have then return v_have; end if;
  v_place := _po_place_label(p_loc, null, p_vehicle_id);
  perform _stock_adjust(m.id, p_loc, p_vehicle_id, p_new - v_have, true);
  perform _po_log('material', m.id, 'stock_count_corrected', format('%s count set to %s (app had %s)%s', v_place, _po_qty(p_new), _po_qty(v_have), coalesce(': ' || nullif(trim(p_reason), ''), '')));
  return p_new;
end;
$$;

-- Material or prebuild added to a do-and-charge variation. A Stock material comes off the Warehouse shelf
-- in the same step (stops at 0 and logs a correction when the app had fewer than were taken).
create or replace function public.variation_material_add(p_variation_id uuid, p_kind text, p_material_id uuid, p_prebuild_id uuid, p_description text, p_quantity numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_id uuid;
  v_have numeric;
  m materials;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_kind not in ('material', 'prebuild') then raise exception 'Pick a Stock item or a prebuild.'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Enter the quantity.'; end if;
  select project_id into v_project from job_variation_entries where id = p_variation_id;
  if v_project is null then raise exception 'Variation not found.'; end if;
  if p_kind = 'material' then
    select * into m from materials where id = p_material_id for update;
    if not found then raise exception 'Stock item not found.'; end if;
  end if;
  insert into job_variation_materials (variation_id, project_id, kind, material_id, prebuild_id, description, quantity, created_by, stock_deducted)
  values (p_variation_id, v_project, p_kind, case when p_kind = 'material' then p_material_id end, case when p_kind = 'prebuild' then p_prebuild_id end,
          coalesce(nullif(trim(p_description), ''), m.name, 'Item'), p_quantity, auth.uid(), p_kind = 'material')
  returning id into v_id;
  if p_kind = 'material' then
    select coalesce(sum(quantity), 0) into v_have from material_stock_by_location where material_id = m.id and location_type = 'warehouse';
    perform _stock_adjust(m.id, 'warehouse', null, -p_quantity, true);
    if v_have < p_quantity then
      perform _po_log('material', m.id, 'stock_count_corrected', format('Warehouse count set to 0: app had %s, %s taken for a variation on %s', _po_qty(v_have), _po_qty(p_quantity), _po_job_ref(v_project)));
    end if;
  end if;
  return v_id;
end;
$$;

-- Saves a reviewed supplier bill in one step (the review screen on a supplier page). Pricing roles.
-- p: { supplier_id, bill_number, bill_date, amount, po_mode: none|existing|new, po_id, new_po: { project_id },
--      file_path, file_name, inbox_item_id,
--      lines: [{ description, quantity, unit_cost, material_id, create_material, replace_po_line_id }] }
-- Never touches stock counts (receiving the PO line does that). A new material gets sell = cost + default markup.
create or replace function public.supplier_bill_save_review(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s suppliers;
  v_num text := nullif(trim(coalesce(p->>'bill_number', '')), '');
  v_date date := nullif(p->>'bill_date', '')::date;
  v_mode text := coalesce(p->>'po_mode', 'none');
  v_po_id uuid := nullif(p->>'po_id', '')::uuid;
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
    if not exists (select 1 from purchase_orders where id = v_po_id and supplier_id = s.id) then raise exception 'That PO is not for %.', s.name; end if;
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
    v_mat := nullif(v_line->>'material_id', '')::uuid;
    if coalesce((v_line->>'create_material')::boolean, false) then
      insert into materials (name, cost_price, sell_price, supplier_id, supplier)
      values (v_desc, v_cost, round(v_cost * (1 + v_markup / 100), 2), s.id, s.name)
      returning id into v_mat;
      perform _po_log('material', v_mat, 'created', format('Added to Stock from bill %s (%s)', coalesce(v_num, ''), s.name));
    elsif v_mat is not null then
      update materials set cost_price = v_cost where id = v_mat and cost_price is distinct from v_cost;
    end if;

    v_po_line := null;
    v_flag := null;
    if v_mode = 'new' then
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
      values (v_po_id, v_mat, v_desc, v_qty, v_cost, auth.uid()) returning id into v_po_line;
    elsif v_po_id is not null then
      v_po_line := nullif(v_line->>'replace_po_line_id', '')::uuid;
      if v_po_line is not null then
        update purchase_order_line_items set material_id = coalesce(v_mat, material_id), description = v_desc where id = v_po_line and po_id = v_po_id;
        if not found then v_po_line := null; end if;
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
        else
          v_flag := 'Not on the linked PO';
        end if;
      end if;
    end if;

    insert into supplier_bill_line_items (bill_id, material_id, description, quantity, unit_cost, po_line_item_id, flag_reason)
    values (v_bill, v_mat, v_desc, v_qty, v_cost, v_po_line, v_flag);
  end loop;

  perform _po_log('supplier', s.id, 'bill_added', format('Bill %s ($%s) saved%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'),
    case when v_po_id is not null then ' against ' || coalesce((select po_number from purchase_orders where id = v_po_id), 'a PO') else '' end));
  if v_po_id is not null then
    perform _po_log('purchase_order', v_po_id, 'bill_added', format('Bill %s ($%s) from %s saved against this PO', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'), s.name));
  end if;
  return v_bill;
end;
$$;

-- Supplier money tiles: Overdue now means approved and past its pay-on date and still not paid.
create or replace function public.get_supplier_financial_summary(p_supplier_id uuid default null)
returns table(supplier_id uuid, invoiced_not_paid numeric, approved_for_payment numeric, not_approved numeric, overdue numeric)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  return query
  select
    sb.supplier_id,
    coalesce(sum(case when not sb.paid then sb.amount else 0 end), 0) as invoiced_not_paid,
    coalesce(sum(case when not sb.paid and sb.approved_for_payment then sb.amount else 0 end), 0) as approved_for_payment,
    coalesce(sum(case when not sb.paid and not sb.approved_for_payment then sb.amount else 0 end), 0) as not_approved,
    coalesce(sum(case when not sb.paid and sb.approved_for_payment and coalesce(sb.pay_on, sb.due_date) < sydney_today() then sb.amount else 0 end), 0) as overdue
  from supplier_bills sb
  where (p_supplier_id is null or sb.supplier_id = p_supplier_id)
    and sb.supplier_id is not null
  group by sb.supplier_id;
end;
$$;

create or replace function public.calculate_bill_due_date(p_bill_date date, p_credit_terms_type text, p_credit_terms_days integer)
returns date language plpgsql immutable set search_path = public as $$
begin
  if p_bill_date is null then return null; end if;
  if p_credit_terms_type = 'cod' then
    return p_bill_date;
  elsif p_credit_terms_type = 'eom_days' then
    return (date_trunc('month', p_bill_date) + interval '1 month - 1 day')::date + coalesce(p_credit_terms_days, 0);
  else
    return p_bill_date + coalesce(p_credit_terms_days, 0);
  end if;
end;
$$;

-- ---------- row level security ----------

-- POs: everyone reads and creates; edits pass through purchase_orders_guard; only pricing roles delete.
drop policy if exists "staff full access on purchase_orders" on public.purchase_orders;
drop policy if exists "Everyone can view POs" on public.purchase_orders;
create policy "Everyone can view POs" on public.purchase_orders for select to authenticated using (true);
drop policy if exists "Everyone can add POs" on public.purchase_orders;
create policy "Everyone can add POs" on public.purchase_orders for insert to authenticated with check ((select auth.uid()) is not null);
drop policy if exists "Everyone can edit POs" on public.purchase_orders;
create policy "Everyone can edit POs" on public.purchase_orders for update to authenticated using (true) with check (true);
drop policy if exists "Pricing roles delete POs" on public.purchase_orders;
create policy "Pricing roles delete POs" on public.purchase_orders for delete to authenticated using ((select is_pricing_role()));

drop policy if exists "Pricing roles delete PO line items" on public.purchase_order_line_items;
create policy "Pricing roles delete PO line items" on public.purchase_order_line_items for delete to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles edit or remove PO line items" on public.purchase_order_line_items;
create policy "Pricing roles edit or remove PO line items" on public.purchase_order_line_items for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));

-- Stock counts: read only from the browser; every change is a server step.
drop policy if exists "Everyone can manage stock locations" on public.material_stock_by_location;

drop policy if exists "Pricing roles manage job material usage" on public.job_material_usage;
create policy "Pricing roles manage job material usage" on public.job_material_usage for all to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles manage bill line items" on public.supplier_bill_line_items;
create policy "Pricing roles manage bill line items" on public.supplier_bill_line_items for all to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles manage supplier bills" on public.supplier_bills;
create policy "Pricing roles manage supplier bills" on public.supplier_bills for all to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles manage supplier payments" on public.supplier_payments;
create policy "Pricing roles manage supplier payments" on public.supplier_payments for all to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles manage statements" on public.supplier_statements;
create policy "Pricing roles manage statements" on public.supplier_statements for all to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));

-- ---------- grants ----------

revoke all on function public._bill_num_norm(text) from public, anon;
revoke all on function public._po_sync_received(uuid) from public, anon, authenticated;
revoke all on function public.po_lines_sync_status() from public, anon, authenticated;
revoke all on function public.po_line_delete_guard() from public, anon, authenticated;
revoke all on function public.purchase_orders_guard() from public, anon, authenticated;
revoke all on function public._po_approve_bills(uuid) from public, anon, authenticated;
revoke all on function public.po_receive_line(uuid, text, uuid) from public, anon;
revoke all on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) from public, anon;
revoke all on function public.po_undo_receive(uuid, text, boolean, date) from public, anon;
revoke all on function public.po_set_closed(uuid, boolean, text, boolean) from public, anon;
revoke all on function public.stock_set_count(uuid, text, uuid, numeric, text) from public, anon;
revoke all on function public.variation_material_add(uuid, text, uuid, uuid, text, numeric) from public, anon;
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
revoke all on function public.get_supplier_financial_summary(uuid) from public, anon;
revoke all on function public.calculate_bill_due_date(date, text, integer) from public, anon;
grant execute on function public._bill_num_norm(text) to authenticated;
grant execute on function public.po_receive_line(uuid, text, uuid) to authenticated;
grant execute on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) to authenticated;
grant execute on function public.po_undo_receive(uuid, text, boolean, date) to authenticated;
grant execute on function public.po_set_closed(uuid, boolean, text, boolean) to authenticated;
grant execute on function public.stock_set_count(uuid, text, uuid, numeric, text) to authenticated;
grant execute on function public.variation_material_add(uuid, text, uuid, uuid, text, numeric) to authenticated;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;
grant execute on function public.get_supplier_financial_summary(uuid) to authenticated;
grant execute on function public.calculate_bill_due_date(date, text, integer) to authenticated;

-- ---------- data ----------

-- status from the lines, for every PO
do $$
declare r record;
begin
  perform set_config('teops.po_step', 'on', true);
  for r in select id from purchase_orders loop
    update purchase_orders p set status = case when p.closed_at is not null then 'closed'
        when exists (select 1 from purchase_order_line_items l where l.po_id = p.id) and not exists (select 1 from purchase_order_line_items l where l.po_id = p.id and not l.received) then 'received'
        when exists (select 1 from purchase_order_line_items l where l.po_id = p.id and l.received) then 'part_received'
        else 'ordered' end
      where p.id = r.id;
  end loop;
end $$;

-- approved, unpaid bills get a pay-on date
update public.supplier_bills set pay_on = greatest(coalesce(due_date, sydney_today()), sydney_today())
  where approved_for_payment and not paid and pay_on is null;
