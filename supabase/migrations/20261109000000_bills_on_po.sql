-- Bills on the PO (docs/PO_REVIEW.md Delivery 2: G1, G2, owner's answer 7).
--
--  * Every bill line that does not match its PO (not on the PO, charged more, or a freight / delivery
--    charge, which is always shown even on an open PO) is red on the PO until a person decides:
--    Accept (adds the line to the PO and costs it, or takes the higher price onto the PO line) or
--    Deny charge (the bill stays unapproved and a please-explain email goes to the supplier).
--  * Open PO (po_type 'open'): the lines are filled in from the supplier's invoice when the bill is
--    saved (linked, received the normal way). A fixed PO only matches. Freight is never filled in.

alter table public.supplier_bill_line_items
  add column if not exists resolution text,
  add column if not exists resolution_note text,
  add column if not exists resolved_by uuid references public.profiles(id) on delete set null,
  add column if not exists resolved_at timestamptz;

alter table public.supplier_bill_line_items drop constraint if exists supplier_bill_line_items_resolution_check;
alter table public.supplier_bill_line_items add constraint supplier_bill_line_items_resolution_check
  check (resolution is null or resolution in ('accepted', 'denied', 'added'));
create index if not exists supplier_bill_line_items_resolved_by_idx on public.supplier_bill_line_items (resolved_by);
create index if not exists supplier_bill_line_items_bill_id_idx on public.supplier_bill_line_items (bill_id);

-- Freight, delivery, shipping and handling lines: never on a PO, always shown.
create or replace function public._is_freight(p text)
returns boolean language sql immutable as $$
  select coalesce(p, '') ~* '(freight|delivery|deliver|shipping|postage|courier|handling|cartage)';
$$;

-- Accept, deny or undo on one bill line. Pricing roles.
--  accept: not on the PO -> a line is added to the PO (linked). Freight, or a closed PO, is received
--          straight to the PO's own destination so it is costed; otherwise it waits for Receive.
--          charged more -> the PO line (and the job's cost rows) take the billed price.
--  deny:   the bill is no longer approved; Query supplier lists the denied charges.
--  undo:   clears an Accept (price) or Deny; an added PO line stays (remove it with Edit lines).
create or replace function public.supplier_bill_line_resolve(p_line_id uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  l supplier_bill_line_items;
  b supplier_bills;
  po purchase_orders;
  pl purchase_order_line_items;
  v_new uuid;
  v_dest text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can decide on bill lines.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into l from supplier_bill_line_items where id = p_line_id for update;
  if not found then raise exception 'That bill line no longer exists.'; end if;
  select * into b from supplier_bills where id = l.bill_id for update;
  if b.paid then raise exception 'Bill % is paid.', coalesce(b.bill_number, ''); end if;
  if b.po_id is not null then select * into po from purchase_orders where id = b.po_id for update; end if;

  if p_action = 'accept' then
    if l.po_line_item_id is null then
      if po.id is null then raise exception 'Link the bill to a PO first.'; end if;
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
      values (po.id, l.material_id, l.description, l.quantity, l.unit_cost, auth.uid()) returning id into v_new;
      update supplier_bill_line_items set po_line_item_id = v_new, resolution = 'added', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = l.id;
      if _is_freight(l.description) or po.closed_at is not null then
        v_dest := case when po.project_id is not null then 'job' when po.vehicle_id is not null then 'vehicle' else 'warehouse' end;
        perform _po_line_land(v_new, v_dest, po.project_id, po.vehicle_id, po.cost_centre_id, false);
        perform _po_log('purchase_order', po.id, 'bill_line_accepted', format('%s x%s ($%s each) from bill %s accepted and added to PO %s, received to %s', l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(b.bill_number, ''), po.po_number, _po_place_label(v_dest, po.project_id, po.vehicle_id)));
        if po.project_id is not null then perform _po_log('project', po.project_id, 'bill_line_accepted', format('%s x%s from bill %s accepted onto PO %s and costed to this job', l.description, _po_qty(l.quantity), coalesce(b.bill_number, ''), po.po_number)); end if;
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
    update supplier_bill_line_items set resolution = 'denied', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now() where id = l.id;
    update supplier_bills set approved_for_payment = false, approved_by = null, approved_at = null, pay_on = null where id = b.id and approved_for_payment;
    perform _po_log('supplier', b.supplier_id, 'bill_line_denied', format('Bill %s: "%s" x%s ($%s each) denied%s', coalesce(b.bill_number, ''), l.description, _po_qty(l.quantity), to_char(l.unit_cost, 'FM999G999G990D00'), coalesce(': ' || v_note, '')));
    if po.id is not null then perform _po_log('purchase_order', po.id, 'bill_line_denied', format('Bill %s: "%s" denied%s', coalesce(b.bill_number, ''), l.description, coalesce(': ' || v_note, ''))); end if;
  elsif p_action = 'undo' then
    if l.resolution = 'added' then raise exception 'Already added to the PO. Remove that PO line instead (Edit lines).'; end if;
    update supplier_bill_line_items set resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where id = l.id;
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

-- Same as migration 20261108000000 plus: on an open PO the bill's lines that are not on it are added to
-- the PO (linked, received the normal way); freight lines are always flagged, never added.
create or replace function public.supplier_bill_save_review(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s suppliers;
  v_num text := nullif(trim(coalesce(p->>'bill_number', '')), '');
  v_date date := nullif(p->>'bill_date', '')::date;
  v_mode text := coalesce(p->>'po_mode', 'none');
  v_po_id uuid := nullif(p->>'po_id', '')::uuid;
  v_po_open boolean := false;
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
    select (po_type = 'open' and closed_at is null) into v_po_open from purchase_orders where id = v_po_id and supplier_id = s.id;
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
    v_mat := nullif(v_line->>'material_id', '')::uuid;
    if coalesce((v_line->>'create_material')::boolean, false) and not _is_freight(v_desc) then
      insert into materials (name, cost_price, sell_price, supplier_id, supplier)
      values (v_desc, v_cost, round(v_cost * (1 + v_markup / 100), 2), s.id, s.name)
      returning id into v_mat;
      perform _po_log('material', v_mat, 'created', format('Added to Stock from bill %s (%s)', coalesce(v_num, ''), s.name));
    elsif v_mat is not null then
      update materials set cost_price = v_cost where id = v_mat and cost_price is distinct from v_cost;
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

    insert into supplier_bill_line_items (bill_id, material_id, description, quantity, unit_cost, po_line_item_id, flag_reason, resolution)
    values (v_bill, v_mat, v_desc, v_qty, v_cost, v_po_line, v_flag, case when v_added then 'added' end);
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

revoke all on function public._is_freight(text) from public, anon;
revoke all on function public.supplier_bill_line_resolve(uuid, text, text) from public, anon;
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
grant execute on function public._is_freight(text) to authenticated;
grant execute on function public.supplier_bill_line_resolve(uuid, text, text) to authenticated;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;

-- freight lines already saved and linked to nothing get the freight flag so they show red
update public.supplier_bill_line_items set flag_reason = 'Freight / delivery charge'
  where po_line_item_id is null and resolution is null and _is_freight(description)
    and exists (select 1 from supplier_bills b where b.id = bill_id and b.po_id is not null);
