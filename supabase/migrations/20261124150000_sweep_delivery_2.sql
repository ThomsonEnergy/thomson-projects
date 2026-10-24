-- Security and bug sweep of 23 Oct 2026 (docs/BUG_REVIEW_2026-10-23.md), delivery 2: the database side.
-- Owner's yes 23 Oct. Applied to production by hand with the database tool, which cannot run a drop
-- statement: every drop below sits on its own line and nothing relies on it (functions and triggers are
-- create or replace, existing policies are altered by name, create policy only for new names).
--
-- Sections
--   1  leave_balances: Xero Payroll leave balances for the Staff page (server writes, own row or finance reads)
--   2  M17: month-by-month profit costs a salaried person's hours at salary / 52 / 38, not $0
--   3  M24, M25: balance due rounds the GST of each certificate credit on its own and a credited credit never
--      pushes the balance above the invoice total
--   4  M19, F38: Move carries the billed quantity's share to the split line and refuses tool lines;
--      un-receive takes only the quantity's worth of Tools register rows
--   5  F12: Close with cancel back orders unlinks the bill lines first
--   6  F13: Accept on a tools PO lands in the Tools register (freight lands nowhere)
--   7  F37: "Update the PO's line to this item" on a received line puts the quantity on the shelf
--   8  F51: a signed HR letter is acknowledged on the Sydney date
--   9  P9: the labour cost, hours and supplier balance functions are for pricing roles
--  10  the last blanket "staff full access" policies
--  11  the two unused secure views
--  12  M26: Record as paid is one database step (supplier_bills_mark_paid), called by run-supplier-payments.js

-- ---------------------------------------------------------------------------------------------------
-- 1. Leave balances (filled by netlify/functions/sync-leave-balances.js from Xero Payroll AU)
-- ---------------------------------------------------------------------------------------------------
create table if not exists public.leave_balances (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  annual_leave_hours numeric,
  sick_leave_hours numeric,
  long_service_hours numeric,
  as_at timestamptz,
  synced_at timestamptz default now()
);
comment on table public.leave_balances is 'Each person''s leave balances copied from Xero Payroll AU by sync-leave-balances. Xero is the source of truth; the browser only reads.';
comment on column public.leave_balances.as_at is 'When Xero gave these figures.';
-- the primary key is the index on the profile_id foreign key (a second index would be a duplicate)
alter table public.leave_balances enable row level security;
drop policy if exists "Staff read own leave balances" on public.leave_balances;
create policy "Staff read own leave balances" on public.leave_balances for select to authenticated
  using (profile_id = (select auth.uid()));
drop policy if exists "Finance roles read all leave balances" on public.leave_balances;
create policy "Finance roles read all leave balances" on public.leave_balances for select to authenticated
  using ((select is_finance_role()));
-- no insert, update or delete policy: only the server (service role) writes a row
revoke all on public.leave_balances from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.leave_balances from authenticated;
grant select on public.leave_balances to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 2. M17: a salaried person's hours cost salary / 52 / 38 an hour when they have no ordinary rate
-- ---------------------------------------------------------------------------------------------------
-- Same hours rule as before (clock_out - clock_in less the break). The Overheads people table costs a salary
-- as salary / paid hours with no super on the hourly figure (super sits in on-costs), so none is added here.
create or replace function public.get_monthly_net_summary(p_months integer default 12)
returns table(month date, revenue numeric, materials numeric, job_labour numeric, gross_profit numeric, direct_overheads numeric, indirect_wages numeric, company_costs numeric, net_profit numeric, job_hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dir numeric; v_nbp numeric; v_co numeric;
begin
  if not is_finance_role() then return; end if;
  select cr.direct_total, cr.nonbillable_people_cost, cr.company_total into v_dir, v_nbp, v_co from compute_overhead_rates() cr;
  return query
  with months as (
    select generate_series(date_trunc('month', now() at time zone 'Australia/Sydney')::date - ((greatest(1, least(p_months, 24)) - 1) || ' months')::interval,
                           date_trunc('month', now() at time zone 'Australia/Sydney')::date, interval '1 month')::date as m),
  rev as (
    select date_trunc('month', i.sent_at at time zone 'Australia/Sydney')::date as m, sum(coalesce(i.labour_amount, 0) + coalesce(i.material_amount, 0)) as v
    from invoices i where i.sent_at is not null group by 1),
  mat as (
    select date_trunc('month', li.received_at at time zone 'Australia/Sydney')::date as m, sum(li.quantity * li.unit_cost) as v
    from purchase_order_line_items li where li.received and li.received_at is not null group by 1),
  tm as (
    select date_trunc('month', t.clock_in at time zone 'Australia/Sydney')::date as m,
      sum(case when t.time_category = 'job' then h.hrs else 0 end) as job_hours,
      sum(case when t.time_category = 'job' then h.hrs * h.rate else 0 end) as job_wages,
      sum(case when t.time_category not in ('job', 'training', 'tafe') and coalesce(op.billable, p.role in ('staff', 'sales')) then h.hrs * h.rate else 0 end) as nonjob_wages
    from time_entries t
    join profiles p on p.id = t.staff_id
    left join overhead_people op on op.profile_id = p.id
    cross join lateral (select extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - coalesce(t.break_minutes, 0) / 60.0 as hrs,
                               -- hourly cost: the ordinary rate, or for a salaried person salary / 52 weeks / 38 hours (M17)
                               coalesce(p.ordinary_rate, case when coalesce(p.annual_salary, 0) > 0 then p.annual_salary / 52.0 / 38.0 end, 0) as rate) h
    where t.clock_out is not null group by 1)
  select mo.m,
    round(coalesce(rev.v, 0), 2), round(coalesce(mat.v, 0), 2), round(coalesce(tm.job_wages, 0), 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0), 2),
    round(v_dir / 12.0, 2),
    round(coalesce(tm.nonjob_wages, 0) + v_nbp / 12.0, 2),
    round(v_co / 12.0, 2),
    round(coalesce(rev.v, 0) - coalesce(mat.v, 0) - coalesce(tm.job_wages, 0) - v_dir / 12.0 - coalesce(tm.nonjob_wages, 0) - v_nbp / 12.0 - v_co / 12.0, 2),
    round(coalesce(tm.job_hours, 0), 2)
  from months mo left join rev on rev.m = mo.m left join mat on mat.m = mo.m left join tm on tm.m = mo.m
  order by mo.m desc;
end;
$$;
revoke execute on function public.get_monthly_net_summary(integer) from public, anon;
grant execute on function public.get_monthly_net_summary(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 3. M24, M25: balance due
-- ---------------------------------------------------------------------------------------------------
-- Labour and materials (less what credit notes gave back) plus GST, less the STC credit and the BSTC credit with the
-- GST of each rounded on its own (stc_credit_inc_gst twice: the same figures invoice.html shows and the Xero
-- lines carry, M25). A credit note that reverses a certificate credit takes that credit down, never below
-- nothing, so the balance can never come out above the invoice total (M24).
-- No caller check: the client's invoice page reaches this through get_invoice_by_token_v3 with no login.
create or replace function public.get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  credited record;
  v_type text;
  v_subtotal numeric;
begin
  select labour_amount, material_amount, stc_amount, bstc_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) as stc,
         coalesce(sum(cnc.bstc_amount), 0) as bstc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  v_type := invoice_client_type(p_invoice_id);
  v_subtotal := coalesce(inv.labour_amount, 0) - credited.labour + coalesce(inv.material_amount, 0) - credited.material;
  return v_subtotal + round(v_subtotal * 0.10, 2)
    - stc_credit_inc_gst(greatest(coalesce(inv.stc_amount, 0) - credited.stc, 0), v_type)
    - stc_credit_inc_gst(greatest(coalesce(inv.bstc_amount, 0) - credited.bstc, 0), v_type);
end;
$$;
revoke execute on function public.get_invoice_balance_due(uuid) from public, anon;
grant execute on function public.get_invoice_balance_due(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 4. M19, F38: Move and un-receive
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

-- Move all or part of a line (same as migration 20261108000000) plus:
--  * a tool line (marked, or on a tools PO) is refused: the split line would land on a job as material and the
--    register would be emptied (F38). A tool moves on the Tools page.
--  * a partial move carries the billed quantity's share over to the split line, so the bill check does not
--    see the whole billed quantity against the smaller original and raise over_quantity (M19).
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
  if po.closed_at is not null then raise exception 'PO % is closed. Ask Admin or Finance to reopen it first.', po.po_number; end if;
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

-- ---------------------------------------------------------------------------------------------------
-- 5. F12: Close with "cancel the back orders"
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
      update supplier_bill_line_items set po_line_item_id = null, flag_reason = coalesce(flag_reason, 'Back order cancelled off ' || po.po_number)
        where po_line_item_id in (select id from purchase_order_line_items where po_id = po.id and not received and is_backordered);
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

-- ---------------------------------------------------------------------------------------------------
-- 6. F13: Accept on a bill line of a tools PO
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261109000000 plus: a line accepted onto a tools PO is received into the Tools register (at the
-- PO's vehicle or the Warehouse) instead of being sent to job / vehicle / warehouse, which _po_line_land refuses
-- for a tool. Freight on a tools PO is neither a tool nor stock: the line is marked received so the PO can close
-- and nothing lands anywhere.
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
    if l.resolution = 'added' then raise exception 'Already added to the PO. Remove that PO line instead (Edit lines).'; end if;
    update supplier_bill_line_items set resolution = null, resolution_note = null, resolved_by = null, resolved_at = null where id = l.id;
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;
revoke all on function public.supplier_bill_line_resolve(uuid, text, text) from public, anon;
grant execute on function public.supplier_bill_line_resolve(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 7. F37: "Update the PO's line to this specific item" on the bill review
-- ---------------------------------------------------------------------------------------------------
-- Same as migration 20261109000000 plus: when the replaced PO line is already received to the Warehouse or a
-- vehicle, the quantity goes onto the new item's count there (and comes off the old item's, if it had one),
-- the way Add to Stock does. A line received to a job has its cost rows pointed at the new item.
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
revoke all on function public.supplier_bill_save_review(jsonb) from public, anon;
grant execute on function public.supplier_bill_save_review(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 8. F51: a signed letter is acknowledged on the Sydney date, not the UTC day
-- ---------------------------------------------------------------------------------------------------
create or replace function public.sign_hr_letter(p_id uuid, p_signature text, p_name text, p_comments text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare w staff_warnings;
begin
  select * into w from staff_warnings where id = p_id;
  if w.id is null or w.profile_id <> auth.uid() or w.sent_to_employee_at is null then raise exception 'Letter not found'; end if;
  if w.employee_signed_at is not null then raise exception 'You have already signed this letter'; end if;
  if coalesce(p_signature, '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'Add your name and signature'; end if;
  update staff_warnings set
    employee_signature_data_url = p_signature,
    employee_signed_name = trim(p_name),
    employee_signed_at = now(),
    employee_signed_how = 'in_app',
    employee_comments = nullif(trim(coalesce(p_comments, '')), ''),
    acknowledged_at = sydney_today(),
    status = case when status = 'issued' then 'acknowledged' else status end,
    updated_at = now()
  where id = p_id;
  perform create_notification(
    w.issued_by, 'hr_letter_signed',
    coalesce((select full_name from profiles where id = w.profile_id), 'An employee') || ' signed their letter',
    coalesce(nullif(w.subject, ''), 'Written warning') || case when coalesce(trim(p_comments), '') <> '' then ' - they added comments' else '' end,
    '/staff.html?id=' || w.profile_id || '&tab=warnings', auth.uid(), 'hr_letter_signed:' || p_id);
end;
$$;
revoke execute on function public.sign_hr_letter(uuid, text, text, text) from public, anon;
grant execute on function public.sign_hr_letter(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 9. P9: pay rates and supplier balances are for pricing roles (same grants as before, the check is inside).
-- Hours in these take the break off (one row per shift with break_minutes on it, M1).
-- ---------------------------------------------------------------------------------------------------
create or replace function public.get_stage_actual_hours(p_cost_centre_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare v numeric;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can see stage hours.'; end if;
  select coalesce(sum(greatest(extract(epoch from (clock_out - clock_in)) / 3600.0 - coalesce(break_minutes, 0) / 60.0, 0)), 0) into v
  from time_entries
  where cost_centre_id = p_cost_centre_id and clock_out is not null;
  return v;
end;
$$;
revoke execute on function public.get_stage_actual_hours(uuid) from public, anon;
grant execute on function public.get_stage_actual_hours(uuid) to authenticated;

create or replace function public.get_stage_actual_labour_cost(p_cost_centre_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  shift_cost numeric := 0;
  allowance_cost numeric := 0;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can see labour costs.'; end if;
  select coalesce(sum(
    (greatest(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0 - coalesce(te.break_minutes, 0) / 60.0, 0)) *
    case classify_timesheet_rate_category(te.clock_in)
      when '2.5x' then coalesce(p.rate_2_5x, p.ordinary_rate, 0)
      when '2x' then coalesce(p.rate_2x, p.ordinary_rate, 0)
      when '1.5x' then coalesce(p.rate_1_5x, p.ordinary_rate, 0)
      else coalesce(p.ordinary_rate, 0)
    end
  ), 0)
  into shift_cost
  from time_entries te
  join profiles p on p.id = te.staff_id
  where te.cost_centre_id = p_cost_centre_id
    and te.clock_out is not null;

  -- Allowances: for each employee-day that touched this stage, apportion
  -- their per-day allowances by (hours on this stage / hours that day
  -- across all stages). Per-hour allowances just apply to the hours
  -- actually logged on this stage directly - no apportionment needed.
  select coalesce(sum(
    case ea.frequency
      when 'per_day' then ea.amount * (stage_hours.hrs / day_hours.total_hrs)
      when 'per_hour' then ea.amount * stage_hours.hrs
      else 0
    end
  ), 0)
  into allowance_cost
  from (
    select te.staff_id, (te.clock_in at time zone 'Australia/Sydney')::date as work_date,
      sum(greatest(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0 - coalesce(te.break_minutes, 0) / 60.0, 0)) as hrs
    from time_entries te
    where te.cost_centre_id = p_cost_centre_id and te.clock_out is not null
    group by te.staff_id, (te.clock_in at time zone 'Australia/Sydney')::date
  ) stage_hours
  join (
    select te.staff_id, (te.clock_in at time zone 'Australia/Sydney')::date as work_date,
      sum(greatest(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0 - coalesce(te.break_minutes, 0) / 60.0, 0)) as total_hrs
    from time_entries te
    where te.clock_out is not null
    group by te.staff_id, (te.clock_in at time zone 'Australia/Sydney')::date
  ) day_hours on day_hours.staff_id = stage_hours.staff_id and day_hours.work_date = stage_hours.work_date
  join employee_allowances ea on ea.profile_id = stage_hours.staff_id
  where day_hours.total_hrs > 0;

  return shift_cost + allowance_cost;
end;
$$;
revoke execute on function public.get_stage_actual_labour_cost(uuid) from public, anon;
grant execute on function public.get_stage_actual_labour_cost(uuid) to authenticated;

create or replace function public.get_stage_actual_material_cost(p_cost_centre_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare v numeric;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can see material costs.'; end if;
  select coalesce(sum(quantity * unit_cost), 0) into v
  from job_material_usage
  where cost_centre_id = p_cost_centre_id;
  return v;
end;
$$;
revoke execute on function public.get_stage_actual_material_cost(uuid) from public, anon;
grant execute on function public.get_stage_actual_material_cost(uuid) to authenticated;

create or replace function public.get_nonbillable_cost_by_category(p_start date, p_end date)
returns table(category text, total_hours numeric, total_cost numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can see wage costs.'; end if;
  return query
  select
    te.time_category,
    coalesce(sum(greatest(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0 - coalesce(te.break_minutes, 0) / 60.0, 0)), 0) as total_hours,
    coalesce(sum(
      (greatest(extract(epoch from (te.clock_out - te.clock_in)) / 3600.0 - coalesce(te.break_minutes, 0) / 60.0, 0)) *
      case classify_timesheet_rate_category(te.clock_in)
        when '2.5x' then coalesce(p.rate_2_5x, p.ordinary_rate, 0)
        when '2x' then coalesce(p.rate_2x, p.ordinary_rate, 0)
        when '1.5x' then coalesce(p.rate_1_5x, p.ordinary_rate, 0)
        else coalesce(p.ordinary_rate, 0)
      end
    ), 0) as total_cost
  from time_entries te
  join profiles p on p.id = te.staff_id
  where te.time_category != 'job'
    and te.clock_out is not null
    and (te.clock_in at time zone 'Australia/Sydney')::date between p_start and p_end
  group by te.time_category;
end;
$$;
revoke execute on function public.get_nonbillable_cost_by_category(date, date) from public, anon;
grant execute on function public.get_nonbillable_cost_by_category(date, date) to authenticated;

-- Supplier money tiles (same as migration 20261108000000) for pricing roles only.
create or replace function public.get_supplier_financial_summary(p_supplier_id uuid default null)
returns table(supplier_id uuid, invoiced_not_paid numeric, approved_for_payment numeric, not_approved numeric, overdue numeric)
language plpgsql security definer set search_path = public as $$
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can see supplier balances.'; end if;
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
revoke all on function public.get_supplier_financial_summary(uuid) from public, anon;
grant execute on function public.get_supplier_financial_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 10. The last blanket "staff full access" policies (all were ALL to authenticated using true)
-- ---------------------------------------------------------------------------------------------------
-- company_credentials: the Team page's insurance section is admin only; Home (admin) and the incident form
-- (finance roles) read them.
alter policy "staff full access on company_credentials" on public.company_credentials to authenticated using ((select is_admin())) with check ((select is_admin()));
alter policy "staff full access on company_credentials" on public.company_credentials rename to "Admin manages company credentials";
drop policy if exists "Finance roles read company credentials" on public.company_credentials;
create policy "Finance roles read company credentials" on public.company_credentials for select to authenticated using ((select is_finance_role()));
-- formbay_webhook_events: the Formbay webhook function writes these with the service role; finance roles may read.
-- An ALL policy cannot become select-only by alter, so its with check is false and the write grants are gone.
alter policy "staff full access on formbay_webhook_events" on public.formbay_webhook_events to authenticated using ((select is_finance_role())) with check (false);
alter policy "staff full access on formbay_webhook_events" on public.formbay_webhook_events rename to "Finance roles read formbay webhook events";
revoke insert, update, delete, truncate, references, trigger on public.formbay_webhook_events from anon, authenticated;
-- asset_reminder_log: not server written. The Customer equipment page (open to every role) logs every reminder email it
-- sends as the sender (assets.js logAssetEmail), and Home and the equipment page read the log. So any logged-in user reads,
-- and adds a row only as themselves; nothing changes or deletes a row from the browser.
alter policy "staff full access on asset_reminder_log" on public.asset_reminder_log to authenticated using (((select auth.uid()) is not null)) with check ((sent_by = (select auth.uid())));
alter policy "staff full access on asset_reminder_log" on public.asset_reminder_log rename to "Logged-in users read and log asset reminders";
revoke update, delete, truncate, references, trigger on public.asset_reminder_log from anon, authenticated;
-- review_requests: pricing roles. The client's review page reads and answers through the server with the token.
alter policy "staff full access on review_requests" on public.review_requests to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on review_requests" on public.review_requests rename to "Pricing roles manage review requests";

-- ---------------------------------------------------------------------------------------------------
-- 11. The two unused secure views (locked in delivery 1; gone on staging and any rebuild)
-- ---------------------------------------------------------------------------------------------------
drop view if exists public.cost_centre_line_items_secure;
drop view if exists public.cost_centres_secure;

-- ---------------------------------------------------------------------------------------------------
-- 12. M26: Record as paid in one step. Called by run-supplier-payments.js with the service role only.
-- ---------------------------------------------------------------------------------------------------
create or replace function public.supplier_bills_mark_paid(p_bill_ids uuid[], p_paid_on date, p_reference text, p_user uuid)
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
    insert into supplier_payments (supplier_id, total_amount, status, initiated_by, paid_on, reference, bill_count)
    values (v_sup.supplier_id, v_sup.total, 'paid', p_user, p_paid_on, p_reference, v_sup.n)
    returning id into v_payment;
    update supplier_bills
      set paid = true, paid_at = now(), paid_by = p_user, payment_id = v_payment, payment_reference = p_reference
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
revoke execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid) from public, anon, authenticated;
grant execute on function public.supplier_bills_mark_paid(uuid[], date, text, uuid) to service_role;
