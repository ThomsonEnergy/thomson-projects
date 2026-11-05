-- Item 51 (owner's yes 5 Nov 2026): paying upfront is normal (card at the counter, a hardware store with no
-- account), so paid must not wait for approval.
--   * A PO can be marked paid on the spot by whoever bought it (paid_method card / cash / bank_transfer / other,
--     paid_on, paid_reference, paid_by), at creation or later (po_set_paid). Every bill saved against a paid PO
--     is approved and marked paid with the PO's details (_bill_paid_from_po), so it never waits in Pay bills due.
--   * supplier_bill_save_review in "new" mode makes the PO from a scanned receipt for any role, with the Create PO
--     panel's own fields (job and stage, vehicle, tools kind, notes, prices, cap, document, paid on the spot).
--   * Admin and Finance can mark any unpaid bill paid, approved or not (supplier_bills_approve_and_mark_paid),
--     now with how it was paid (supplier_bills.paid_method, supplier_payments.method).
--   * A closed (approved or paid) PO still lets its received lines move to another job, the Warehouse or a
--     vehicle (po_move_line); the PO stays closed and its bills are untouched.

alter table public.purchase_orders
  add column if not exists paid_method text,
  add column if not exists paid_on date,
  add column if not exists paid_reference text,
  add column if not exists paid_by uuid references public.profiles(id);
alter table public.purchase_orders drop constraint if exists purchase_orders_paid_method_check;
alter table public.purchase_orders add constraint purchase_orders_paid_method_check
  check (paid_method is null or paid_method in ('card', 'cash', 'bank_transfer', 'airwallex', 'other'));
create index if not exists purchase_orders_paid_by_idx on public.purchase_orders (paid_by) where paid_by is not null;

alter table public.supplier_bills add column if not exists paid_method text;
alter table public.supplier_payments add column if not exists method text;

-- "card", "cash", "bank transfer", "Airwallex", "other"
create or replace function public._paid_method_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'card' then 'card' when 'cash' then 'cash' when 'bank_transfer' then 'bank transfer' when 'airwallex' then 'Airwallex' else 'other' end;
$$;
revoke all on function public._paid_method_label(text) from public, anon;
grant execute on function public._paid_method_label(text) to authenticated;

-- A bill on a PO that was paid at the counter: approved (a formality) and marked paid with the PO's date, method
-- and reference, its own supplier_payments row, logged on the supplier and the PO. Does nothing when the PO is not
-- paid or the bill already is. Called by supplier_bill_save_review, po_set_paid and the server (emailed bills).
create or replace function public._bill_paid_from_po(p_bill_id uuid, p_po_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b supplier_bills;
  po purchase_orders;
  v_payment uuid;
  v_ref text;
  v_who uuid;
  v_on date;
begin
  select * into b from supplier_bills where id = p_bill_id for update;
  if not found or b.paid or b.supplier_id is null then return; end if;
  select * into po from purchase_orders where id = p_po_id;
  if not found or po.paid_method is null then return; end if;
  v_who := coalesce(po.paid_by, auth.uid());
  v_on := coalesce(po.paid_on, b.bill_date, sydney_today());
  v_ref := coalesce(nullif(trim(coalesce(po.paid_reference, '')), ''), 'Paid by ' || _paid_method_label(po.paid_method) || ' on PO ' || coalesce(po.po_number, ''));
  insert into supplier_payments (supplier_id, total_amount, status, initiated_by, paid_on, reference, bill_count, method)
  values (b.supplier_id, coalesce(b.amount, 0), 'paid', v_who, v_on, v_ref, 1, po.paid_method)
  returning id into v_payment;
  update supplier_bills
    set approved_for_payment = true, approved_by = coalesce(approved_by, v_who), approved_at = coalesce(approved_at, now()), pay_on = v_on,
        paid = true, paid_at = now(), paid_by = v_who, payment_id = v_payment, payment_reference = v_ref, paid_method = po.paid_method
    where id = b.id;
  perform _po_log('supplier', b.supplier_id, 'bills_paid', format('Paid $%s on %s by %s: bill %s (PO %s was paid at the time%s)',
    to_char(coalesce(b.amount, 0), 'FM999G999G990D00'), to_char(v_on, 'DD Mon YYYY'), _paid_method_label(po.paid_method), coalesce(b.bill_number, '(no number)'), coalesce(po.po_number, ''),
    case when po.paid_reference is not null then ', ' || po.paid_reference else '' end));
  perform _po_log('purchase_order', po.id, 'bill_paid', format('Bill %s ($%s) saved and marked paid: this PO was paid by %s on %s',
    coalesce(b.bill_number, '(no number)'), to_char(coalesce(b.amount, 0), 'FM999G999G990D00'), _paid_method_label(po.paid_method), to_char(v_on, 'DD Mon YYYY')));
end;
$$;
revoke all on function public._bill_paid_from_po(uuid, uuid) from public, anon, authenticated;
grant execute on function public._bill_paid_from_po(uuid, uuid) to service_role;

-- "Paid already" on a PO, by whoever bought it (any role), at creation or later under More. Its unpaid bills are
-- marked paid at once; a bill that arrives later is marked paid when it is saved. p_method null takes it back
-- (refused while a bill on it is marked paid: mark the bill not paid first, on the supplier page).
create or replace function public.po_set_paid(p_po_id uuid, p_method text, p_paid_on date default null, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  po purchase_orders;
  b record;
  v_on date := coalesce(p_paid_on, sydney_today());
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into po from purchase_orders where id = p_po_id for update;
  if not found then raise exception 'That PO no longer exists.'; end if;
  if po.stock_source is not null then raise exception 'A stock PO is not paid to anyone.'; end if;
  if p_method is null then
    if po.paid_method is null then return; end if;
    if exists (select 1 from supplier_bills where po_id = po.id and paid) then
      raise exception 'A bill on PO % is marked paid. Mark it not paid first (supplier page), then take this back.', po.po_number;
    end if;
    update purchase_orders set paid_method = null, paid_on = null, paid_reference = null, paid_by = null where id = po.id;
    perform _po_log('purchase_order', po.id, 'paid_cleared', format('PO %s: not paid after all (was marked paid by %s)', po.po_number, _paid_method_label(po.paid_method)));
    return;
  end if;
  if p_method not in ('card', 'cash', 'bank_transfer', 'airwallex', 'other') then raise exception 'Unknown payment method.'; end if;
  if v_on > sydney_today() then raise exception 'The paid date cannot be in the future.'; end if;
  update purchase_orders set paid_method = p_method, paid_on = v_on, paid_reference = nullif(trim(coalesce(p_reference, '')), ''), paid_by = auth.uid() where id = po.id;
  perform _po_log('purchase_order', po.id, 'paid', format('PO %s paid by %s on %s%s', po.po_number, _paid_method_label(p_method), to_char(v_on, 'DD Mon YYYY'),
    case when nullif(trim(coalesce(p_reference, '')), '') is not null then ' (' || trim(p_reference) || ')' else '' end));
  for b in select id from supplier_bills where po_id = po.id and not paid loop
    perform _bill_paid_from_po(b.id, po.id);
  end loop;
end;
$$;
revoke all on function public.po_set_paid(uuid, text, date, text) from public, anon;
grant execute on function public.po_set_paid(uuid, text, date, text) to authenticated;

-- Paid any time (Admin and Finance), with how it was paid. The old four-argument versions go so the
-- named-argument calls from the server are not ambiguous.
drop function if exists public.supplier_bills_approve_and_mark_paid(uuid, date, text, uuid);
drop function if exists public.supplier_bills_mark_paid(uuid[], date, text, uuid);
create or replace function public.supplier_bills_mark_paid(p_bill_ids uuid[], p_paid_on date, p_reference text, p_user uuid, p_method text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := array(select distinct unnest(p_bill_ids));
  v_bad text;
  v_sup record;
  v_payment uuid;
  v_count integer;
  v_out jsonb := '[]'::jsonb;
begin
  -- the server calls this with no user; a logged-in caller must be Admin or Finance
  if auth.uid() is not null and not is_finance_role() then raise exception 'Only Admin or Finance can record payments.'; end if;
  if coalesce(cardinality(v_ids), 0) = 0 then raise exception 'Pick at least one bill.'; end if;
  if p_paid_on is null then raise exception 'Enter the date paid.'; end if;
  if p_method is not null and p_method not in ('card', 'cash', 'bank_transfer', 'airwallex', 'other') then raise exception 'Unknown payment method.'; end if;

  -- lock the bills: a second press waits here, then sees them paid and is refused
  perform 1 from supplier_bills where id = any(v_ids) for update;
  if (select count(*) from supplier_bills where id = any(v_ids)) <> cardinality(v_ids) then raise exception 'One of those bills was not found. Reload the page.'; end if;

  select string_agg(coalesce(bill_number, '(no number)'), ', ') into v_bad from supplier_bills where id = any(v_ids) and not approved_for_payment;
  if v_bad is not null then raise exception 'Not approved for payment yet: %. Approve first.', v_bad; end if;
  select string_agg(coalesce(bill_number, '(no number)'), ', ') into v_bad from supplier_bills where id = any(v_ids) and paid;
  if v_bad is not null then raise exception 'Already recorded as paid: %.', v_bad; end if;
  select string_agg(coalesce(bill_number, '(no number)'), ', ') into v_bad from supplier_bills where id = any(v_ids) and supplier_id is null;
  if v_bad is not null then raise exception 'No supplier on bill %. Pick the supplier first.', v_bad; end if;

  for v_sup in
    select b.supplier_id, s.name, sum(b.amount) as total, count(*)::integer as n,
           string_agg(coalesce(b.bill_number, '(no number)'), ', ' order by b.bill_number) as numbers
    from supplier_bills b join suppliers s on s.id = b.supplier_id
    where b.id = any(v_ids)
    group by b.supplier_id, s.name
  loop
    insert into supplier_payments (supplier_id, total_amount, status, initiated_by, paid_on, reference, bill_count, method)
    values (v_sup.supplier_id, v_sup.total, 'paid', p_user, p_paid_on, p_reference, v_sup.n, p_method)
    returning id into v_payment;
    update supplier_bills
      set paid = true, paid_at = now(), paid_by = p_user, payment_id = v_payment, payment_reference = p_reference, paid_method = p_method
      where id = any(v_ids) and supplier_id = v_sup.supplier_id and not paid;
    get diagnostics v_count = row_count;
    if v_count <> v_sup.n then raise exception 'Those bills changed while the payment was being recorded. Reload and try again.'; end if;
    insert into activity_log (entity_type, entity_id, action, description, changed_by)
    values ('supplier', v_sup.supplier_id, 'bills_paid',
            format('Paid $%s on %s%s: bill%s %s', to_char(v_sup.total, 'FM999G999G990D00'), to_char(p_paid_on, 'DD Mon YYYY'),
                   case when p_reference is not null then ' (' || p_reference || ')' else '' end,
                   case when v_sup.n = 1 then '' else 's' end, v_sup.numbers), p_user);
    v_out := v_out || jsonb_build_object('supplier_id', v_sup.supplier_id, 'supplier', v_sup.name, 'amount', v_sup.total, 'bill_count', v_sup.n, 'payment_id', v_payment);
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid, text) from public, anon, authenticated;
grant execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid, text) to service_role;
create or replace function public.supplier_bills_approve_and_mark_paid(p_bill_id uuid, p_paid_on date, p_reference text, p_user uuid, p_method text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approved boolean;
begin
  -- the server calls this with no user; a logged-in caller must be Admin or Finance
  if auth.uid() is not null and not is_finance_role() then raise exception 'Only Admin or Finance can record payments.'; end if;
  if p_paid_on > sydney_today() then raise exception 'The paid date cannot be in the future.'; end if;

  select approved_for_payment into v_approved from supplier_bills where id = p_bill_id for update;
  if not found then raise exception 'That bill was not found. Reload the page.'; end if;

  -- paid already, so approval is a formality: approved by the person pressing the button, due the day it was paid
  if not v_approved then
    update supplier_bills set approved_for_payment = true, approved_by = p_user, approved_at = now(), pay_on = p_paid_on where id = p_bill_id;
  end if;
  return supplier_bills_mark_paid(array[p_bill_id], p_paid_on, p_reference, p_user, p_method);
end;
$$;
revoke execute on function public.supplier_bills_approve_and_mark_paid(uuid, date, text, uuid, text) from public, anon, authenticated;
grant execute on function public.supplier_bills_approve_and_mark_paid(uuid, date, text, uuid, text) to service_role;

-- The reviewed save: any role in "new" mode (the PO from a scanned receipt), the panel's fields on the new PO,
-- the bill paid when the PO is. Everything else as migration 20261128050000.
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
    select (po_type = 'open' and closed_at is null), po_number into v_po_open, v_po_number from purchase_orders where id = v_po_id and supplier_id = s.id;
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
  perform supplier_bill_price_lines(v_bill, is_pricing_role());

  perform _po_log('supplier', s.id, 'bill_added', format('Bill %s ($%s) saved%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'),
    case when v_po_id is not null then ' against ' || coalesce((select po_number from purchase_orders where id = v_po_id), 'a PO') else '' end));
  if v_po_id is not null then
    perform _po_log('purchase_order', v_po_id, 'bill_added', format('Bill %s ($%s) from %s saved against this PO%s', coalesce(v_num, ''), to_char(coalesce((p->>'amount')::numeric, 0), 'FM999G999G990D00'), s.name,
      case when v_po_open then ' (open PO: its lines were filled in from the bill)' else '' end));
  end if;
  -- the PO was paid at the counter (item 51): this bill is approved and paid with the PO's details
  if v_po_id is not null then perform _bill_paid_from_po(v_bill, v_po_id); end if;
  return v_bill;
end;
$$;
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;

-- Received lines move after the PO is closed. Everything else as migration 20261124150000.
create or replace function public.po_move_line(p_line_id uuid, p_qty numeric, p_dest text, p_job_id uuid default null, p_vehicle_id uuid default null, p_cost_centre_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  bl supplier_bill_line_items;
  v_target uuid;
  v_from text;
  v_to text;
  v_share numeric;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  -- item 51: a closed (approved, paid) PO still lets its received lines move to another job or stock;
  -- the PO stays closed and its bills are untouched, the cost rows follow the gear
  if po.closed_at is not null and not li.received then raise exception 'PO % is closed: only received lines can be moved.', po.po_number; end if;
  if li.is_tool or po.po_kind = 'tools' then
    raise exception '% is a tool: receive it to Tools, or change where it sits on the Tools page.', li.description;
  end if;
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
    -- each bill line on the original hands the moved share of its quantity to the split line (M19)
    for bl in select * from supplier_bill_line_items where po_line_item_id = li.id loop
      v_share := round(bl.quantity * p_qty / li.quantity, 4);
      if v_share <= 0 then continue; end if;
      if v_share >= bl.quantity then
        update supplier_bill_line_items set po_line_item_id = v_target where id = bl.id;
      else
        insert into supplier_bill_line_items (bill_id, material_id, description, quantity, unit_cost, po_line_item_id, flag_reason, resolution, resolution_note, resolved_by, resolved_at)
        values (bl.bill_id, bl.material_id, bl.description, v_share, bl.unit_cost, v_target, bl.flag_reason, bl.resolution, bl.resolution_note, bl.resolved_by, bl.resolved_at);
        update supplier_bill_line_items set quantity = quantity - v_share where id = bl.id;
      end if;
    end loop;
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
revoke all on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.po_move_line(uuid, numeric, text, uuid, uuid, uuid) to authenticated;
