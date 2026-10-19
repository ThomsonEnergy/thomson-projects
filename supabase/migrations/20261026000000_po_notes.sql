-- PO notes (docs/PROJECT_SPEC.md A10): "Notes for supplier" print on the PO PDF (po.html),
-- "Internal notes" are staff only. Both can be edited any time, even on a closed PO.

alter table public.purchase_orders
  add column if not exists supplier_notes text,
  add column if not exists internal_notes text;

-- same as migration 20261025000000, plus the supplier notes (never the internal ones)
create or replace function public.get_po_by_token(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'po', jsonb_build_object('po_number', po.po_number, 'order_date', po.order_date, 'description', po.description,
      'supplier_name', coalesce(s.name, po.supplier_name), 'closed', po.closed_at is not null,
      'supplier_notes', po.supplier_notes),
    'deliver', case
      when po.project_id is not null then jsonb_build_object('job_number', p.job_number, 'job_name', p.name, 'address', p.client_address)
      when po.vehicle_id is not null then jsonb_build_object('label', coalesce(v.vehicle_name, v.rego))
      else jsonb_build_object('label', 'Warehouse') end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.created_at, li.id)
                       from purchase_order_line_items li where li.po_id = po.id), '[]'::jsonb),
    'company', (select jsonb_build_object('company_name', company_name, 'abn', abn, 'address', address, 'phone', phone,
                       'website', website, 'licenses', licenses, 'logo_url', logo_url) from company_settings where id = 1))
  from purchase_orders po
  left join suppliers s on s.id = po.supplier_id
  left join projects p on p.id = po.project_id
  left join fleet_vehicles v on v.id = po.vehicle_id
  where po.po_token = p_token;
$$;

grant execute on function public.get_po_by_token(uuid) to anon, authenticated;
