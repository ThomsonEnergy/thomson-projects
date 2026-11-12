-- Supplier credit notes against POs, Move to another PO, Remove bill (items 82 and 83 part B, 13 Nov 2026).
--
--  * A credit note is a bill with a minus in front: supplier_bills.kind = 'credit_note', a negative amount,
--    its lines with negative quantities linked to the PO's lines. Everything that adds up bills (supplier
--    balances, Pay bills due, the bill check's PO totals, statements) nets it off by itself.
--  * supplier_credit_note_save: one step, all or nothing. The credit is approved for payment at once (it is
--    the supplier's money back) with pay-on today, so it joins the next pay run. A line that matches a PO
--    line either took the goods back (goods_returned: the PO line's quantity drops, received goods come out
--    of Stock, the van or off the job's cost) or is a price credit (goods kept, the PO line's cost drops).
--  * supplier_bill_relocate / supplier_bill_remove: a bill on the wrong PO is moved or taken out, lines
--    Accept added to the old PO come off it (received ones come back out of stock or off the job), the
--    lines are linked against the new PO, logged on both POs and the supplier.
--  * supplier_bills_mark_paid: a supplier whose net is below zero is refused ("credit bigger than the
--    bills"), unless it is only credit notes being recorded as refunded (method 'refund').
--  * supplier_bill_line_resolve: Undo on an Accept that added a line takes the line off the PO again.

alter table public.supplier_bills add column if not exists kind text not null default 'bill';
alter table public.supplier_bills drop constraint if exists supplier_bills_kind_check;
alter table public.supplier_bills add constraint supplier_bills_kind_check check (kind in ('bill', 'credit_note'));
alter table public.supplier_bills drop constraint if exists supplier_bills_amount_sign_check;
alter table public.supplier_bills add constraint supplier_bills_amount_sign_check
  check ((kind = 'bill' and coalesce(amount, 0) >= 0) or (kind = 'credit_note' and coalesce(amount, 0) <= 0));

alter table public.supplier_bill_line_items add column if not exists goods_returned boolean;

-- ---------- helpers ----------

-- Takes a line Accept (or an open PO) added to a PO off it again: received goods come back out of stock,
-- the van, the tools register or off the job's cost (refused if invoiced to the client), then the line goes.
create or replace function public._po_line_unadd(p_line uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
begin
  select * into li from purchase_order_line_items where id = p_line for update;
  if not found then return; end if;
  perform set_config('teops.po_step', 'on', true);
  if li.received then perform _po_line_take_back(li.id, li.quantity); end if;
  update supplier_bill_line_items set po_line_item_id = null where po_line_item_id = li.id;
  delete from purchase_order_line_items where id = li.id;
end;
$$;
revoke all on function public._po_line_unadd(uuid) from public, anon, authenticated;

-- Links one bill line to a PO line the way the reviewed save does: the same Stock item, the same part
-- number (the item's own or the supplier's), or the same description. Null when nothing matches.
create or replace function public._po_line_for_bill_line(p_po uuid, p_material uuid, p_description text, p_part text, p_supplier uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
  v_part text := _part_norm(p_part);
begin
  if p_material is not null then
    select id into v_id from purchase_order_line_items where po_id = p_po and material_id = p_material order by created_at limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  if v_part is not null then
    select pl.id into v_id from purchase_order_line_items pl
      left join materials m on m.id = pl.material_id
      left join material_supplier_links k on k.material_id = pl.material_id and k.supplier_id = p_supplier
      where pl.po_id = p_po and (_part_norm(m.part_number) = v_part or _part_norm(k.part_number) = v_part)
      order by pl.created_at limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  select id into v_id from purchase_order_line_items where po_id = p_po and lower(trim(description)) = lower(trim(coalesce(p_description, ''))) order by created_at limit 1;
  return v_id;
end;
$$;
revoke all on function public._po_line_for_bill_line(uuid, uuid, text, text, uuid) from public, anon, authenticated;

-- ---------- credit notes ----------

-- p: { supplier_id, credit_number, credit_date, amount (positive, inc GST as printed), po_id (null = money only),
--      file_path, file_name, notes, user_id (the server passes who; a browser call uses auth.uid()),
--      lines: [{ description, part_number, quantity (positive), unit_cost (positive, ex GST), material_id,
--                po_line_item_id (null = money only), goods_returned (true: goods went back; false: price credit) }] }
create or replace function public.supplier_credit_note_save(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s suppliers;
  po purchase_orders;
  pl purchase_order_line_items;
  v_user uuid := coalesce(auth.uid(), nullif(p->>'user_id', '')::uuid);
  v_num text := nullif(trim(coalesce(p->>'credit_number', '')), '');
  v_date date := coalesce(nullif(p->>'credit_date', '')::date, sydney_today());
  v_amount numeric := abs(coalesce((p->>'amount')::numeric, 0));
  v_po_id uuid := nullif(p->>'po_id', '')::uuid;
  v_credit uuid;
  v_line jsonb;
  v_qty numeric;
  v_cost numeric;
  v_desc text;
  v_po_line uuid;
  v_returned boolean;
  v_take numeric;
  v_new_cost numeric;
  v_why text;
  v_what text;
  v_lines_text text := '';
begin
  if auth.uid() is not null and not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can save credit notes.'; end if;
  if v_amount <= 0 then raise exception 'Enter the credit amount.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into s from suppliers where id = (p->>'supplier_id')::uuid;
  if not found then raise exception 'Supplier not found.'; end if;
  if v_num is not null and exists (select 1 from supplier_bills where supplier_id = s.id and kind = 'credit_note' and _bill_num_norm(bill_number) = _bill_num_norm(v_num)) then
    raise exception 'Credit note % from % is already in TEops. Not saved again.', v_num, s.name;
  end if;
  if v_po_id is not null then
    select * into po from purchase_orders where id = v_po_id for update;
    if not found then raise exception 'That PO no longer exists.'; end if;
    if po.supplier_id is distinct from s.id then raise exception '% is for %, not %.', po.po_number, coalesce(po.supplier_name, 'another supplier'), s.name; end if;
  end if;

  -- approved at once: it is their money back, nothing to approve; pay-on today so it nets in the next pay run
  insert into supplier_bills (kind, supplier_id, supplier_name, bill_number, bill_date, amount, po_id, file_path, file_name, notes, created_by,
                              approved_for_payment, approved_by, approved_at, pay_on, check_status, check_issues, checked_at)
  values ('credit_note', s.id, s.name, v_num, v_date, -v_amount, v_po_id, nullif(p->>'file_path', ''), nullif(p->>'file_name', ''), nullif(p->>'notes', ''), v_user,
          true, v_user, now(), sydney_today(), 'matches', '[]'::jsonb, now())
  returning id into v_credit;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    v_desc := nullif(trim(coalesce(v_line->>'description', '')), '');
    if v_desc is null then continue; end if;
    v_qty := abs(coalesce((v_line->>'quantity')::numeric, 1));
    v_cost := abs(coalesce((v_line->>'unit_cost')::numeric, 0));
    v_po_line := nullif(v_line->>'po_line_item_id', '')::uuid;
    v_returned := coalesce((v_line->>'goods_returned')::boolean, false);
    v_what := 'money only';
    v_why := null;
    pl := null;
    if v_po_line is not null and po.id is not null then
      select * into pl from purchase_order_line_items where id = v_po_line and po_id = po.id for update;
      if not found then v_po_line := null; end if;
    else
      v_po_line := null;
    end if;

    if pl.id is not null and v_qty > 0 then
      if v_returned then
        -- the goods went back: what was received comes out of stock, the van or off the job; the PO line shrinks
        v_take := least(v_qty, pl.quantity);
        if pl.received and v_take > 0 then
          begin
            perform _po_line_take_back(pl.id, v_take);
            v_what := 'returned, taken ' || case when pl.destination_type = 'job' then 'off ' || _po_job_ref(pl.destination_job_id) else 'out of ' || _po_place_label(pl.destination_type, pl.destination_job_id, pl.destination_vehicle_id) end;
          exception when others then
            -- already invoiced to the client, or no longer there: the credit still saves, money only
            v_returned := false;
            v_why := sqlerrm;
            v_what := 'money only (' || sqlerrm || ')';
          end;
        elsif v_take > 0 then
          v_what := 'returned, taken off the order';
        end if;
        if v_returned then
          if v_take >= pl.quantity - 0.0005 then
            update supplier_bill_line_items set po_line_item_id = null where po_line_item_id = pl.id;
            v_po_line := null;
            delete from purchase_order_line_items where id = pl.id;
            v_what := v_what || ', line removed from the PO';
          else
            update purchase_order_line_items set quantity = quantity - v_take where id = pl.id;
          end if;
        end if;
      else
        -- a price credit: the goods stay, the PO line (and the job's cost rows) drop to what we end up paying
        v_new_cost := greatest(0, round(pl.unit_cost - (v_qty * v_cost) / nullif(pl.quantity, 0), 2));
        update purchase_order_line_items set unit_cost = v_new_cost where id = pl.id;
        update job_material_usage set unit_cost = v_new_cost where po_line_item_id = pl.id;
        v_what := format('price credit, the PO line now $%s each (was $%s)', to_char(v_new_cost, 'FM999G999G990D00'), to_char(pl.unit_cost, 'FM999G999G990D00'));
      end if;
    end if;

    insert into supplier_bill_line_items (bill_id, material_id, description, part_number, quantity, unit_cost, unit, po_line_item_id, goods_returned, resolution_note)
    values (v_credit, coalesce(nullif(v_line->>'material_id', '')::uuid, pl.material_id), v_desc, nullif(v_line->>'part_number', ''), -v_qty, v_cost,
            nullif(left(coalesce(v_line->>'unit', ''), 20), ''), v_po_line, case when pl.id is not null then v_returned end, v_why);
    v_lines_text := v_lines_text || format('%s x%s: %s; ', v_desc, _po_qty(v_qty), v_what);
  end loop;

  if po.id is not null then perform _po_sync_received(po.id); end if;
  perform _po_log('supplier', s.id, 'credit_note_added', format('Credit note %s ($%s) saved%s. %s', coalesce(v_num, '(no number)'), to_char(v_amount, 'FM999G999G990D00'),
    case when po.id is not null then ' against ' || po.po_number else '' end, v_lines_text));
  if po.id is not null then
    perform _po_log('purchase_order', po.id, 'credit_note_added', format('Credit note %s ($%s) from %s saved against this PO. %s', coalesce(v_num, '(no number)'), to_char(v_amount, 'FM999G999G990D00'), s.name, v_lines_text));
    if po.project_id is not null then
      perform _po_log('project', po.project_id, 'credit_note_added', format('Credit note %s ($%s) from %s on PO %s. %s', coalesce(v_num, '(no number)'), to_char(v_amount, 'FM999G999G990D00'), s.name, po.po_number, v_lines_text));
    end if;
  end if;
  return v_credit;
end;
$$;
revoke all on function public.supplier_credit_note_save(jsonb) from public, anon;
grant execute on function public.supplier_credit_note_save(jsonb) to authenticated;

-- ---------- a bill on the wrong PO ----------

-- Moves a bill to another PO (p_po_id null = no PO). Lines Accept added to the old PO come off it; the lines
-- are linked against the new PO (an open PO takes them as new lines, the way a save does); the decisions are
-- cleared and the bill is no longer approved (the new PO's close, or the bill check on a closed PO, approves it).
-- The server re-runs the bill check on both POs afterwards. Refused while the bill is paid.
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
    v_open := new_po.po_type = 'open' and new_po.closed_at is null;
  end if;

  -- off the old PO: lines Accept (or an open PO) added come off it, every link is cleared
  for l in select * from supplier_bill_line_items where bill_id = b.id loop
    if l.resolution = 'added' and l.po_line_item_id is not null then perform _po_line_unadd(l.po_line_item_id); end if;
  end loop;
  update supplier_bill_line_items set po_line_item_id = null, flag_reason = null, resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where bill_id = b.id;

  -- onto the new PO: linked the way a save links, flagged when not on it, added when the PO is open
  for l in select * from supplier_bill_line_items where bill_id = b.id order by created_at loop
    v_po_line := null; v_flag := null; v_res := null;
    if new_po.id is not null and not _is_freight(l.description) and not (coalesce(l.quantity, 0) <= 0 or coalesce(l.unit_cost, 0) <= 0) then
      v_po_line := _po_line_for_bill_line(new_po.id, l.material_id, l.description, l.part_number, b.supplier_id);
      if v_po_line is null and v_open then
        insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
        values (new_po.id, l.material_id, l.description, l.quantity, l.unit_cost, v_user) returning id into v_new;
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

-- Takes a bill out of TEops (not ours, paid by the customer, entered by mistake). Lines Accept added to its
-- PO come off it; the emailed card is put aside with the reason so the mailbox sweep never offers it again.
-- Refused while paid. A credit note that changed its PO's lines is refused (put the lines back by hand first).
create or replace function public.supplier_bill_remove(p_bill_id uuid, p_reason text, p_user uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  b supplier_bills;
  po purchase_orders;
  l record;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_word text;
begin
  if auth.uid() is not null and not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can remove a bill.'; end if;
  if v_reason is null then raise exception 'Say why it is being removed (it goes in the log).'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into b from supplier_bills where id = p_bill_id for update;
  if not found then raise exception 'That bill no longer exists.'; end if;
  if b.paid then raise exception '% % is recorded as paid. Mark it not paid first (supplier page).', case when b.kind = 'credit_note' then 'Credit note' else 'Bill' end, coalesce(b.bill_number, ''); end if;
  -- a credit line that matched a PO line changed it (goods_returned set and no "money only" note): the quantity dropped,
  -- the line went, or the price dropped. That is not undone here.
  if b.kind = 'credit_note' and exists (select 1 from supplier_bill_line_items where bill_id = b.id and goods_returned is not null and resolution_note is null) then
    raise exception 'Credit note % changed its PO''s lines (goods taken back, a line removed or a price dropped). Put those lines right by hand (Edit lines on the PO), then remove it.', coalesce(b.bill_number, '');
  end if;
  if b.po_id is not null then select * into po from purchase_orders where id = b.po_id for update; end if;
  v_word := case when b.kind = 'credit_note' then 'Credit note' else 'Bill' end;

  for l in select * from supplier_bill_line_items where bill_id = b.id loop
    if l.resolution = 'added' and l.po_line_item_id is not null then perform _po_line_unadd(l.po_line_item_id); end if;
  end loop;
  update supplier_bill_inbox set status = 'not_a_bill', bill_id = null, po_id = null, match_confidence = 'none',
    match_reason = format('Removed from TEops: %s', v_reason), resolved_by = coalesce(auth.uid(), p_user), resolved_at = now()
    where bill_id = b.id;
  delete from supplier_bills where id = b.id;
  if po.id is not null then perform _po_sync_received(po.id); end if;

  perform _po_log('supplier', b.supplier_id, 'bill_removed', format('%s %s ($%s) removed%s: %s', v_word, coalesce(b.bill_number, '(no number)'), to_char(abs(coalesce(b.amount, 0)), 'FM999G999G990D00'),
    case when po.id is not null then ' from ' || po.po_number else '' end, v_reason));
  if po.id is not null then
    perform _po_log('purchase_order', po.id, 'bill_removed', format('%s %s ($%s) taken off this PO: %s', v_word, coalesce(b.bill_number, '(no number)'), to_char(abs(coalesce(b.amount, 0)), 'FM999G999G990D00'), v_reason));
    if po.project_id is not null then perform _po_log('project', po.project_id, 'bill_removed', format('%s %s taken off PO %s: %s', v_word, coalesce(b.bill_number, '(no number)'), po.po_number, v_reason)); end if;
  end if;
end;
$$;
revoke all on function public.supplier_bill_remove(uuid, text, uuid) from public, anon;
grant execute on function public.supplier_bill_remove(uuid, text, uuid) to authenticated;

-- ---------- paying: credits net off, never below zero ----------

-- Same as migration 20261129000000 plus: credit notes net against the supplier's bills in the batch; a supplier
-- whose net is below zero is refused, unless only credit notes are being recorded as refunded (method 'refund').
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
  if p_method is not null and p_method not in ('card', 'cash', 'bank_transfer', 'airwallex', 'refund', 'other') then raise exception 'Unknown payment method.'; end if;

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
           bool_and(b.kind = 'credit_note') as only_credits,
           string_agg(coalesce(b.bill_number, '(no number)') || case when b.kind = 'credit_note' then ' (credit)' else '' end, ', ' order by b.bill_number) as numbers
    from supplier_bills b join suppliers s on s.id = b.supplier_id
    where b.id = any(v_ids)
    group by b.supplier_id, s.name
  loop
    if v_sup.total < -0.005 and not (v_sup.only_credits and p_method = 'refund') then
      raise exception 'Credit bigger than the bills for %: wait for the next bill, or press Refunded on the credit note when the money comes back.', v_sup.name;
    end if;
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
            format('%s $%s on %s%s: %s %s', case when v_sup.only_credits and p_method = 'refund' then 'Refunded' else 'Paid' end,
                   to_char(abs(v_sup.total), 'FM999G999G990D00'), to_char(p_paid_on, 'DD Mon YYYY'),
                   case when p_reference is not null then ' (' || p_reference || ')' else '' end,
                   case when v_sup.n = 1 then 'bill' else 'bills' end, v_sup.numbers), p_user);
    v_out := v_out || jsonb_build_object('supplier_id', v_sup.supplier_id, 'supplier', v_sup.name, 'amount', v_sup.total, 'bill_count', v_sup.n, 'payment_id', v_payment);
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid, text) from public, anon, authenticated;
grant execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid, text) to service_role;

-- ---------- Undo on an Accept that added a line ----------

-- Same as migration 20261124150000 plus: undo on an 'added' line takes the line off the PO again
-- (received goods come back out of stock or off the job; refused if invoiced to the client).
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
      insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
      values (po.id, l.material_id, l.description, l.quantity, l.unit_cost, auth.uid()) returning id into v_new;
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
