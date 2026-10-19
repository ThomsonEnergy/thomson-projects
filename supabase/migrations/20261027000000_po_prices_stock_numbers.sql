-- PO follow-ups (docs/PROJECT_SPEC.md A10):
--  * Prices on the PO sent to the supplier are off by default (purchase_orders.show_prices), toggled per PO.
--  * Every PO gets a number: a PO saved without one draws the next (the "Create a PO from this bill"
--    screen on a supplier page never set one). Blank ones are numbered now.
--  * Add a PO line to Stock: creates the Stock item, links the line, and catches the count up if the
--    line was already received to the Warehouse or a vehicle.

alter table public.purchase_orders add column if not exists show_prices boolean not null default false;

create or replace function public.purchase_orders_fill_number()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(new.po_number), '') = '' then
    update company_settings set next_po_number = next_po_number + 1 where id = 1
      returning coalesce(nullif(po_number_prefix, ''), 'PO') || (next_po_number - 1) into new.po_number;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_purchase_orders_fill_number on public.purchase_orders;
create trigger trg_purchase_orders_fill_number before insert on public.purchase_orders
  for each row execute function public.purchase_orders_fill_number();

do $$
declare r record; v_num text;
begin
  for r in select id from purchase_orders where coalesce(trim(po_number), '') = '' order by created_at loop
    update company_settings set next_po_number = next_po_number + 1 where id = 1
      returning coalesce(nullif(po_number_prefix, ''), 'PO') || (next_po_number - 1) into v_num;
    update purchase_orders set po_number = v_num where id = r.id;
  end loop;
end $$;

-- Pricing roles (who can add Stock items) turn a PO line into a Stock item.
create or replace function public.po_line_add_to_stock(p_line_id uuid, p_name text, p_category text, p_supplier_id uuid,
  p_cost numeric, p_sell numeric, p_minimum numeric default 0)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_mat uuid;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can add Stock items.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  if li.material_id is not null then raise exception 'That line is already a Stock item.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Give the Stock item a name.'; end if;
  select * into po from purchase_orders where id = li.po_id;

  insert into materials (name, category, supplier_id, supplier, cost_price, sell_price, minimum_quantity)
  values (trim(p_name), nullif(trim(coalesce(p_category, '')), ''), p_supplier_id,
          (select name from suppliers where id = p_supplier_id),
          coalesce(p_cost, 0), coalesce(p_sell, 0), coalesce(p_minimum, 0))
  returning id into v_mat;

  update purchase_order_line_items set material_id = v_mat where id = li.id;
  if li.received and li.destination_type in ('warehouse', 'vehicle') then
    perform _stock_adjust(v_mat, li.destination_type, li.destination_vehicle_id, li.quantity);
  elsif li.received and li.destination_type = 'job' then
    update job_material_usage set material_id = v_mat where po_line_item_id = li.id and material_id is null;
  end if;

  perform _po_log('purchase_order', po.id, 'added_to_stock', format('%s added to Stock from PO %s', trim(p_name), po.po_number));
  perform _po_log('material', v_mat, 'created', format('Added to Stock from PO %s%s', po.po_number,
    case when li.received and li.destination_type in ('warehouse', 'vehicle')
      then format(' (%s already received to %s)', _po_qty(li.quantity), _po_place_label(li.destination_type, null, li.destination_vehicle_id)) else '' end));
  return v_mat;
end;
$$;

-- same as migration 20261026000000, plus show_prices: unit prices are only sent when it is on
create or replace function public.get_po_by_token(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'po', jsonb_build_object('po_number', po.po_number, 'order_date', po.order_date, 'description', po.description,
      'supplier_name', coalesce(s.name, po.supplier_name), 'closed', po.closed_at is not null,
      'supplier_notes', po.supplier_notes, 'show_prices', po.show_prices),
    'deliver', case
      when po.project_id is not null then jsonb_build_object('job_number', p.job_number, 'job_name', p.name, 'address', p.client_address)
      when po.vehicle_id is not null then jsonb_build_object('label', coalesce(v.vehicle_name, v.rego))
      else jsonb_build_object('label', 'Warehouse') end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity,
                         'unit_cost', case when po.show_prices then li.unit_cost end) order by li.created_at, li.id)
                       from purchase_order_line_items li where li.po_id = po.id), '[]'::jsonb),
    'company', (select jsonb_build_object('company_name', company_name, 'abn', abn, 'address', address, 'phone', phone,
                       'website', website, 'licenses', licenses, 'logo_url', logo_url) from company_settings where id = 1))
  from purchase_orders po
  left join suppliers s on s.id = po.supplier_id
  left join projects p on p.id = po.project_id
  left join fleet_vehicles v on v.id = po.vehicle_id
  where po.po_token = p_token;
$$;

revoke all on function public.purchase_orders_fill_number() from public, anon, authenticated;
revoke all on function public.po_line_add_to_stock(uuid, text, text, uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.po_line_add_to_stock(uuid, text, text, uuid, numeric, numeric, numeric) to authenticated;
grant execute on function public.get_po_by_token(uuid) to anon, authenticated;
