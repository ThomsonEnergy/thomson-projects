-- F4 (docs/BUG_REVIEW.md): Mark back ordered did nothing for Staff. PO line updates are pricing
-- roles only, so RLS matched 0 rows and returned no error. This step works for every logged-in
-- role, like the other po_ steps: the line must exist, not be received, and its PO must be open.

create or replace function public.po_set_backorder(p_line_id uuid, p_backordered boolean, p_eta date default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_on boolean := coalesce(p_backordered, false);
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if po.closed_at is not null then raise exception 'PO % is closed. Reopen it first.', po.po_number; end if;
  if li.received then raise exception 'That line is already received.'; end if;

  update purchase_order_line_items set
    is_backordered = v_on,
    backorder_eta = case when v_on then p_eta end
  where id = li.id;

  perform _po_log('purchase_order', po.id, case when v_on then 'item_backordered' else 'item_not_backordered' end,
    case when v_on
      then format('%s x%s back ordered%s', li.description, _po_qty(li.quantity), coalesce(', expected ' || to_char(p_eta, 'DD/MM/YYYY'), ''))
      else format('%s x%s no longer back ordered', li.description, _po_qty(li.quantity)) end);
end;
$$;

revoke all on function public.po_set_backorder(uuid, boolean, date) from public, anon;
grant execute on function public.po_set_backorder(uuid, boolean, date) to authenticated;
