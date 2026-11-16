-- Item 84, first slice (owner 16 Nov 2026): a bill's lines that are not on the PO land on the PO by
-- themselves, on any PO that is not closed (it was Open POs only; a fixed PO showed each one red
-- for Accept, one at a time). Nobody accepts them: they sit on the PO marked as not on the original
-- PO until someone ticks them received, which is the check that the goods are there. Deny charge
-- still takes a line back off the PO and asks the supplier.
--   1. purchase_order_line_items.added_from_bill: the line came from a supplier's bill, not from
--      what was ordered. Everyone who can see the PO sees it (field staff cannot read bills).
--   2. supplier_bill_save_review (upload, review screen, scan) and supplier_bill_relocate (Move a
--      bill to another PO): the rule above. The emailed save has it in _shared/supplier-bill-intake.js.
--   3. supplier_bill_line_resolve: Accept marks the line it adds; Deny on a line the bill put on
--      the PO takes it off the PO.
-- Nothing is approved or paid that was not before: a PO still closes only when every line is
-- received, back ordered or moved off, and closing is still the approval step.

alter table public.purchase_order_line_items add column if not exists added_from_bill boolean not null default false;
comment on column public.purchase_order_line_items.added_from_bill is 'The line was put on the PO by a supplier bill (not on the PO as ordered). Shown as "Not on the original PO" until received.';

-- lines already added from a bill (an Open PO's lines, or an Accept) carry the mark too
update public.purchase_order_line_items li set added_from_bill = true
 where not li.added_from_bill
   and exists (select 1 from public.supplier_bill_line_items bl where bl.po_line_item_id = li.id and bl.resolution = 'added');

-- ---------- 2a. save from the review screen, an upload or a scan ----------
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
  v_paid_method text := nullif(p->'new_po'->>'paid_method', '');
  v_po_kind text := coalesce(nullif(p->'new_po'->>'po_kind', ''), 'materials');
  v_tools_kind text := nullif(p->'new_po'->>'tools_kind', '');
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  -- item 51: anyone can save the receipt for the PO they are creating from a scan (po_mode new); the rest is pricing roles
  if not is_pricing_role() and v_mode <> 'new' then raise exception 'Only Admin, Finance or Sales can save supplier bills.'; end if;
  if v_paid_method is not null and v_paid_method not in ('card', 'cash', 'bank_transfer', 'airwallex', 'other') then raise exception 'Unknown payment method.'; end if;
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
    -- item 84: any PO that is not closed takes the bill's lines that are not on it (it was open POs only)
    select (closed_at is null), po_number into v_po_open, v_po_number from purchase_orders where id = v_po_id and supplier_id = s.id;
    if not found then raise exception 'That PO is not for %.', s.name; end if;
  elsif v_mode = 'new' then
    -- the panel's own fields come along (item 51: job and stage, vehicle, tools, notes, prices, cap, document, paid on the spot)
    insert into purchase_orders (project_id, cost_centre_id, vehicle_id, po_kind, supplier_id, supplier_name, po_type, locked, status, amount, description,
                                 supplier_notes, internal_notes, show_prices, budget_cap, file_path, file_name, paid_method, paid_on, paid_reference, paid_by)
    values (nullif(p->'new_po'->>'project_id', '')::uuid, nullif(p->'new_po'->>'cost_centre_id', '')::uuid, nullif(p->'new_po'->>'vehicle_id', '')::uuid, v_po_kind,
            s.id, s.name, 'fixed', false, 'ordered', 0, coalesce(nullif(p->'new_po'->>'description', ''), 'Created from bill ' || coalesce(v_num, '')),
            nullif(p->'new_po'->>'supplier_notes', ''), nullif(p->'new_po'->>'internal_notes', ''), coalesce((p->'new_po'->>'show_prices')::boolean, false),
            nullif(p->'new_po'->>'budget_cap', '')::numeric, nullif(p->'new_po'->>'file_path', ''), nullif(p->'new_po'->>'file_name', ''),
            v_paid_method, case when v_paid_method is not null then coalesce(nullif(p->'new_po'->>'paid_on', '')::date, v_date, sydney_today()) end,
            case when v_paid_method is not null then nullif(p->'new_po'->>'paid_reference', '') end, case when v_paid_method is not null then auth.uid() end)
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
    if coalesce((v_line->>'create_material')::boolean, false) and is_pricing_role() and not _is_freight(v_desc) then
      insert into materials (name, part_number, cost_price, sell_price, supplier_id, supplier)
      values (v_desc, v_part, v_cost, round(v_cost * (1 + v_markup / 100), 2), s.id, s.name)
      returning id into v_mat;
      perform _po_log('material', v_mat, 'created', format('Added to Stock from bill %s (%s)', coalesce(v_num, ''), s.name));
    end if;

    v_po_line := null;
    v_flag := null;
    v_added := false;
    if v_mode = 'new' and not _is_freight(v_desc) then
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by, is_tool, tool_kind)
      values (v_po_id, case when v_po_kind = 'tools' then null else v_mat end, v_desc, v_qty, v_cost, auth.uid(), v_po_kind = 'tools', case when v_po_kind = 'tools' then coalesce(v_tools_kind, 'tool') end)
      returning id into v_po_line;
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
          elsif v_po_open and v_qty > 0 and v_cost > 0 then
            -- nothing charged (0 supplied, or $0) is never added: the same rule as the emailed save
            insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by, added_from_bill)
            values (v_po_id, v_mat, v_desc, v_qty, v_cost, auth.uid(), true) returning id into v_po_line;
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
  perform supplier_bill_price_lines(v_bill, is_pricing_role());

  perform _po_log('supplier', s.id, 'bill_added', format('Bill %s ($%s) saved%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'),
    case when v_po_id is not null then ' against ' || coalesce((select po_number from purchase_orders where id = v_po_id), 'a PO') else '' end));
  if v_po_id is not null then
    perform _po_log('purchase_order', v_po_id, 'bill_added', format('Bill %s ($%s) from %s saved against this PO%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'), s.name,
      case when exists (select 1 from supplier_bill_line_items where bill_id = v_bill and resolution = 'added') then ' (its lines that were not on the PO were added to it)' else '' end));
  end if;
  -- the PO was paid at the counter (item 51): this bill is approved and paid with the PO's details
  if v_po_id is not null then perform _bill_paid_from_po(v_bill, v_po_id); end if;
  return v_bill;
end;
$$;
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;

-- ---------- 2b. Move a bill to another PO ----------
create or replace function public.supplier_bill_relocate(p_bill_id uuid, p_po_id uuid, p_note text default null, p_user uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  b supplier_bills;
  old_po purchase_orders;
  new_po purchase_orders;
  l record;
  v_user uuid := coalesce(auth.uid(), p_user);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_po_line uuid;
  v_new uuid;
  v_open boolean := false;
  v_flag text;
  v_res text;
begin
  if auth.uid() is not null and not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can move a bill.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into b from supplier_bills where id = p_bill_id for update;
  if not found then raise exception 'That bill no longer exists.'; end if;
  if b.paid then raise exception 'Bill % is recorded as paid. Mark it not paid first (supplier page).', coalesce(b.bill_number, ''); end if;
  if b.kind = 'credit_note' then raise exception 'A credit note stays on its PO. Remove it and save it again against the right PO.'; end if;
  if b.po_id is not distinct from p_po_id then raise exception 'That is the PO it is on.'; end if;
  if b.po_id is not null then select * into old_po from purchase_orders where id = b.po_id for update; end if;
  if p_po_id is not null then
    select * into new_po from purchase_orders where id = p_po_id for update;
    if not found then raise exception 'That PO no longer exists.'; end if;
    if new_po.supplier_id is distinct from b.supplier_id then raise exception '% is for %, not %.', new_po.po_number, coalesce(new_po.supplier_name, 'another supplier'), coalesce(b.supplier_name, 'this supplier'); end if;
    v_open := new_po.closed_at is null; -- item 84: any PO that is not closed takes the lines
  end if;

  -- off the old PO: lines Accept (or an open PO) added come off it, every link is cleared
  for l in select * from supplier_bill_line_items where bill_id = b.id loop
    if l.resolution = 'added' and l.po_line_item_id is not null then perform _po_line_unadd(l.po_line_item_id); end if;
  end loop;
  update supplier_bill_line_items set po_line_item_id = null, flag_reason = null, resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where bill_id = b.id;

  -- onto the new PO: linked the way a save links; a line not on it is added (flagged only when the PO is closed)
  for l in select * from supplier_bill_line_items where bill_id = b.id order by created_at loop
    v_po_line := null; v_flag := null; v_res := null;
    if new_po.id is not null and not _is_freight(l.description) and not (coalesce(l.quantity, 0) <= 0 or coalesce(l.unit_cost, 0) <= 0) then
      v_po_line := _po_line_for_bill_line(new_po.id, l.material_id, l.description, l.part_number, b.supplier_id);
      if v_po_line is null and v_open then
        insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by, added_from_bill)
        values (new_po.id, l.material_id, l.description, l.quantity, l.unit_cost, v_user, true) returning id into v_new;
        v_po_line := v_new; v_res := 'added';
      elsif v_po_line is null then
        v_flag := 'Not on the linked PO';
      else
        select case when l.unit_cost > unit_cost * 1.01 + 0.005 then format('Charged $%s, PO expected $%s', to_char(l.unit_cost, 'FM999G999G990D00'), to_char(unit_cost, 'FM999G999G990D00')) end
          into v_flag from purchase_order_line_items where id = v_po_line;
      end if;
    elsif new_po.id is not null and _is_freight(l.description) then
      v_flag := 'Freight / delivery charge';
    end if;
    update supplier_bill_line_items set po_line_item_id = v_po_line, flag_reason = v_flag, resolution = v_res where id = l.id;
  end loop;

  update supplier_bills set po_id = p_po_id, approved_for_payment = false, approved_by = null, approved_at = null, pay_on = null,
    check_status = case when p_po_id is null then 'no_po' else check_status end
    where id = b.id;
  update supplier_bill_inbox set po_id = p_po_id where bill_id = b.id;
  if old_po.id is not null then perform _po_sync_received(old_po.id); end if;
  if new_po.id is not null then perform _po_sync_received(new_po.id); end if;

  perform _po_log('supplier', b.supplier_id, 'bill_moved', format('Bill %s ($%s) moved from %s to %s%s', coalesce(b.bill_number, '(no number)'), to_char(coalesce(b.amount, 0), 'FM999G999G990D00'),
    coalesce(old_po.po_number, 'no PO'), coalesce(new_po.po_number, 'no PO'), coalesce(': ' || v_note, '')));
  if old_po.id is not null then
    perform _po_log('purchase_order', old_po.id, 'bill_moved', format('Bill %s ($%s) moved off this PO to %s%s', coalesce(b.bill_number, '(no number)'), to_char(coalesce(b.amount, 0), 'FM999G999G990D00'), coalesce(new_po.po_number, 'no PO'), coalesce(': ' || v_note, '')));
    if old_po.project_id is not null then perform _po_log('project', old_po.project_id, 'bill_moved', format('Bill %s moved off PO %s to %s', coalesce(b.bill_number, '(no number)'), old_po.po_number, coalesce(new_po.po_number, 'no PO'))); end if;
  end if;
  if new_po.id is not null then
    perform _po_log('purchase_order', new_po.id, 'bill_moved', format('Bill %s ($%s) moved here from %s%s', coalesce(b.bill_number, '(no number)'), to_char(coalesce(b.amount, 0), 'FM999G999G990D00'), coalesce(old_po.po_number, 'no PO'), coalesce(': ' || v_note, '')));
    if new_po.project_id is not null then perform _po_log('project', new_po.project_id, 'bill_moved', format('Bill %s moved onto PO %s from %s', coalesce(b.bill_number, '(no number)'), new_po.po_number, coalesce(old_po.po_number, 'no PO'))); end if;
  end if;
end;
$$;
revoke all on function public.supplier_bill_relocate(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.supplier_bill_relocate(uuid, uuid, text, uuid) to authenticated;

-- ---------- 3. Accept, Deny charge, Undo on a bill line ----------
create or replace function public.supplier_bill_line_resolve(p_line_id uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  l supplier_bill_line_items;
  b supplier_bills;
  po purchase_orders;
  pl purchase_order_line_items;
  v_new uuid;
  v_dest text;
  v_place text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can decide on bill lines.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into l from supplier_bill_line_items where id = p_line_id for update;
  if not found then raise exception 'That bill line no longer exists.'; end if;
  select * into b from supplier_bills where id = l.bill_id for update;
  if b.paid then raise exception 'Bill % is paid.', coalesce(b.bill_number, ''); end if;
  if b.kind = 'credit_note' then raise exception 'A credit note''s lines are not accepted or denied.'; end if;
  if b.po_id is not null then select * into po from purchase_orders where id = b.po_id for update; end if;

  if p_action = 'accept' then
    if l.po_line_item_id is null then
      if po.id is null then raise exception 'Link the bill to a PO first.'; end if;
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by, added_from_bill)
      values (po.id, l.material_id, l.description, l.quantity, l.unit_cost, auth.uid(), true) returning id into v_new;
      update supplier_bill_line_items set po_line_item_id = v_new, resolution = 'added', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = l.id;
      if _is_freight(l.description) or po.closed_at is not null then
        if po.po_kind = 'tools' and _is_freight(l.description) then
          update purchase_order_line_items set received = true, received_by = auth.uid(), received_at = now(), is_backordered = false, backorder_eta = null where id = v_new;
          perform _po_log('purchase_order', po.id, 'bill_line_accepted', format('%s x%s ($%s each) from bill %s accepted and added to PO %s (freight on a tools PO: nothing to receive)', l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(b.bill_number, ''), po.po_number));
        else
          v_dest := case when po.po_kind = 'tools' then 'tools' when po.project_id is not null then 'job' when po.vehicle_id is not null then 'vehicle' else 'warehouse' end;
          perform _po_line_land(v_new, v_dest, po.project_id, po.vehicle_id, po.cost_centre_id, false);
          v_place := case when v_dest = 'tools' then 'Tools' || case when po.vehicle_id is not null then ' in ' || _po_place_label('vehicle', null, po.vehicle_id) else ' at the Warehouse' end
                          else _po_place_label(v_dest, po.project_id, po.vehicle_id) end;
          perform _po_log('purchase_order', po.id, 'bill_line_accepted', format('%s x%s ($%s each) from bill %s accepted and added to PO %s, received to %s', l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(b.bill_number, ''), po.po_number, v_place));
          if v_dest = 'job' then perform _po_log('project', po.project_id, 'bill_line_accepted', format('%s x%s from bill %s accepted onto PO %s and costed to this job', l.description, _po_qty(l.quantity), coalesce(b.bill_number, ''), po.po_number)); end if;
        end if;
      else
        perform _po_log('purchase_order', po.id, 'bill_line_accepted', format('%s x%s ($%s each) from bill %s accepted and added to PO %s (receive it when it arrives)', l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(b.bill_number, ''), po.po_number));
      end if;
      perform _po_sync_received(po.id);
    else
      select * into pl from purchase_order_line_items where id = l.po_line_item_id for update;
      if found and l.unit_cost > pl.unit_cost then
        update purchase_order_line_items set unit_cost = l.unit_cost where id = pl.id;
        update job_material_usage set unit_cost = l.unit_cost where po_line_item_id = pl.id;
        perform _po_log('purchase_order', po.id, 'bill_line_accepted', format('%s: price accepted at $%s (PO said $%s) from bill %s%s', pl.description, to_char(l.unit_cost, 'FM999G999G990D00'), to_char(pl.unit_cost, 'FM999G999G990D00'), coalesce(b.bill_number, ''), coalesce(': ' || v_note, '')));
      end if;
      update supplier_bill_line_items set resolution = 'accepted', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = l.id;
    end if;
  elsif p_action = 'deny' then
    -- item 84: a line the bill put on the PO comes off the PO with the charge (a received one is un-received first)
    if l.resolution = 'added' and l.po_line_item_id is not null then
      perform _po_line_unadd(l.po_line_item_id);
      update supplier_bill_line_items set po_line_item_id = null, flag_reason = 'Not on the linked PO' where id = l.id;
      if po.id is not null then
        perform _po_log('purchase_order', po.id, 'bill_line_unaccepted', format('%s x%s from bill %s taken off PO %s (charge denied)', l.description, _po_qty(l.quantity), coalesce(b.bill_number, ''), po.po_number));
        perform _po_sync_received(po.id);
      end if;
    end if;
    update supplier_bill_line_items set resolution = 'denied', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = l.id;
    update supplier_bills set approved_for_payment = false, approved_by = null, approved_at = null, pay_on = null where id = b.id and approved_for_payment;
    perform _po_log('supplier', b.supplier_id, 'bill_line_denied', format('Bill %s: "%s" x%s ($%s each) denied%s', coalesce(b.bill_number, ''), l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(': ' || v_note, '')));
    if po.id is not null then perform _po_log('purchase_order', po.id, 'bill_line_denied', format('Bill %s: "%s" denied%s', coalesce(b.bill_number, ''), l.description, coalesce(': ' || v_note, ''))); end if;
  elsif p_action = 'undo' then
    if l.resolution = 'added' and l.po_line_item_id is not null then
      perform _po_line_unadd(l.po_line_item_id);
      update supplier_bill_line_items set po_line_item_id = null, flag_reason = 'Not on the linked PO', resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where id = l.id;
      if po.id is not null then
        perform _po_log('purchase_order', po.id, 'bill_line_unaccepted', format('%s x%s from bill %s taken off PO %s again (Accept undone)', l.description, _po_qty(l.quantity), coalesce(b.bill_number, ''), po.po_number));
        perform _po_sync_received(po.id);
      end if;
    else
      update supplier_bill_line_items set resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where id = l.id;
    end if;
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;
revoke all on function public.supplier_bill_line_resolve(uuid, text, text) from public, anon;
grant execute on function public.supplier_bill_line_resolve(uuid, text, text) to authenticated;
