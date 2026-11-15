-- Item 88: delete a PO line that no bill charges for (a line typed in by hand that the supplier's
-- bill did not match, or one added by mistake). One step, all or nothing:
--   1. a received line comes back off the job's costs, the stock count or the Tools register first
--      (po_undo_receive, the same step as Undo received, so a stock pull goes back where it came from);
--   2. the line goes, and the PO's received state is worked out again (trg_po_lines_sync_status).
-- Refused when a bill or credit note charges for the line, when the goods are already invoiced to
-- the client (the take-back says so), and on a closed PO. Pricing roles only.
-- Called by the PO page (js/po-bills.js). Writes purchase_order_line_items, activity_log and
-- whatever po_undo_receive writes (job_material_usage, stock counts, tools).

create or replace function public.po_line_delete(p_line_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_bill text;
  v_text text;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can delete a PO line.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id for update;
  if po.closed_at is not null then raise exception 'PO % is closed. Reopen it first.', po.po_number; end if;

  select coalesce(case when b.kind = 'credit_note' then 'credit note ' else 'bill ' end || nullif(b.bill_number, ''), 'a bill') into v_bill
    from supplier_bill_line_items bl join supplier_bills b on b.id = bl.bill_id
    where bl.po_line_item_id = li.id
    order by b.bill_date desc nulls last limit 1;
  if found then
    raise exception '% is charged on %, so it stays on the PO. If that bill is wrong, remove or move the bill first.', li.description, v_bill;
  end if;

  if li.received then perform po_undo_receive(li.id, 'deleted from the PO'); end if;
  if exists (select 1 from job_material_usage where po_line_item_id = li.id) then
    raise exception '% still has costs on a job. Check that job''s materials first.', li.description;
  end if;

  delete from purchase_order_line_items where id = li.id;

  v_text := format('%s x%s ($%s each) deleted from the PO', li.description, _po_qty(li.quantity), to_char(coalesce(li.unit_cost, 0), 'FM999G999G990D00'));
  perform _po_log('purchase_order', po.id, 'po_item_deleted', v_text);
  if po.project_id is not null then
    perform _po_log('project', po.project_id, 'po_item_deleted', format('PO %s: %s', po.po_number, v_text));
  end if;
end;
$$;

revoke execute on function public.po_line_delete(uuid) from public, anon;
grant execute on function public.po_line_delete(uuid) to authenticated;
