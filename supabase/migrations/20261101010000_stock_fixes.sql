-- Stock / PO fixes (docs/BUG_REVIEW.md M7a, M7b, M7c). Function bodies copied from migration
-- 20261025000000_po_upgrades.sql, then changed.
--
-- One rule for where a line's gear comes from, used by receive, move and undo alike:
--  * stock PO (stock_source set): the Warehouse or vehicle it was pulled from;
--  * old "pull from Warehouse to a vehicle" PO (vehicle, no supplier, no stock_source): the Warehouse.
-- The first receive of a not-received line (Receive, or Move of a not-received line) takes it out of
-- that source; Undo received puts it back there, wherever the line has been moved since.
-- Moving a received line never touches the source (it comes out of where it is now).

-- M7a + M7b: take the qty out of the PO's source on every first receive, whatever the destination.
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
  else
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

-- M7c: refuse if the job's usage rows no longer cover the qty being taken back.
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
  end if;
end;
$$;

-- M7b: Undo refunds the PO's source by PO type, not by where the line is now.
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
    coalesce(': ' || nullif(trim(p_note), ''), ''));
  perform _po_log('purchase_order', po.id, 'item_unreceived', v_text);
  if li.destination_type = 'job' then
    perform _po_log('project', li.destination_job_id, 'material_unreceived', format('PO %s: %s', po.po_number, v_text));
  end if;
  perform _po_sync_received(po.id);
end;
$$;

revoke all on function public._po_line_land(uuid, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public._po_line_take_back(uuid, numeric) from public, anon, authenticated;
revoke all on function public.po_undo_receive(uuid, text, boolean, date) from public, anon;
grant execute on function public.po_undo_receive(uuid, text, boolean, date) to authenticated;
