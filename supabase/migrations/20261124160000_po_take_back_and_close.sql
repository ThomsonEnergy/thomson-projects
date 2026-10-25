-- Security and bug sweep of 23 Oct 2026 (docs/BUG_REVIEW_2026-10-23.md), delivery 2, the two PO functions
-- that hold delete statements. Split off 20261124150000_sweep_delivery_2.sql (owner's yes 23 and 24 Oct) because
-- the cloud database tool cannot run a delete statement inside a function body (it waits for a confirmation it
-- cannot show); the rest of delivery 2 went live by hand on 24 Oct. This file goes to production with
-- `supabase db push` from the laptop (docs/STAGING.md); until then production runs the 20261111000000 and
-- 20261108000000 versions of these two functions (same arguments, same callers).
--
-- Sections
--   1  F38: un-receive takes only the quantity's worth of Tools register rows
--   2  F12: Close with "cancel the back orders" unlinks the bill lines first and holds their bills
--      for a decision instead of approving them

-- ---------------------------------------------------------------------------------------------------
-- 1. F38: un-receive of a tools line
-- ---------------------------------------------------------------------------------------------------
-- Takes p_qty of a received line back out (same as migration 20261111000000) except in the Tools register,
-- where only the quantity's worth of rows goes: whole tools are one row each, a perishable is one row with a
-- count. Rows marked broken, lost or sold stay, so a line that has one of those cannot be fully un-received (F38).
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

-- ---------------------------------------------------------------------------------------------------
-- 2. F12: Close with "cancel the back orders"
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261108000000 plus: a supplier bill line linked to a back ordered line is unlinked (and
-- flagged so it shows red for a decision) before the line is deleted, instead of the delete failing on the
-- foreign key with no screen to fix it.
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
      -- bill lines that pointed at a cancelled line come off it first (F12); they show red until a person decides
      -- their bills are not approved by this close (the line is red): they wait for a person to decide
      with unlinked as (
        update supplier_bill_line_items set po_line_item_id = null, flag_reason = coalesce(flag_reason, 'Back order cancelled off ' || po.po_number)
          where po_line_item_id in (select id from purchase_order_line_items where po_id = po.id and not received and is_backordered)
          returning bill_id)
      update supplier_bills set check_status = 'problems'
        where id in (select bill_id from unlinked) and not paid;
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
revoke all on function public.po_set_closed(uuid, boolean, text, boolean) from public, anon;
grant execute on function public.po_set_closed(uuid, boolean, text, boolean) to authenticated;
