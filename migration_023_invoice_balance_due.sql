-- Migration 023 — Single source of truth for "what does this invoice owe"
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The GST bug (Airwallex charged the ex-GST subtotal while the invoice
-- page correctly showed the GST-inclusive balance) happened because the
-- same subtotal -> +GST -> -STC formula was written out independently in
-- two places (the invoice page's own display logic, and the payment link
-- creation code) and they drifted apart. This function makes that
-- calculation exist in exactly one place - every consumer (the invoice
-- page, Airwallex payment links, and anything built later that needs to
-- know an invoice's balance due, including deposits/progress claims)
-- calls this, rather than each reimplementing the arithmetic themselves.

-- Same calculation, callable from server-side Netlify functions using the
-- service-role client - identical logic, just without needing to look up
-- an invoice row first if the raw figures are already in hand (used when
-- a Netlify function already has the invoice loaded and just needs the
-- number, not another round trip).
create or replace function calculate_balance_due(p_labour numeric, p_material numeric, p_stc numeric)
returns numeric
language plpgsql
security definer
as $$
declare
  subtotal numeric;
  gst numeric;
begin
  subtotal := coalesce(p_labour, 0) + coalesce(p_material, 0);
  gst := round(subtotal * 0.10, 2);
  return subtotal + gst - coalesce(p_stc, 0);
end;
$$;

-- Convenience wrapper for when only the invoice ID is on hand - looks the
-- row up, then delegates the actual arithmetic to calculate_balance_due
-- above rather than repeating the formula here too.
create or replace function get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
as $$
declare
  inv record;
begin
  select labour_amount, material_amount, stc_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  return calculate_balance_due(inv.labour_amount, inv.material_amount, inv.stc_amount);
end;
$$;

-- Updated to include balance_due directly, computed via the function
-- above rather than leaving the invoice page to work it out itself
-- client-side - the invoice page and the Airwallex payment link now both
-- get this number from the exact same place.

create or replace function get_invoice_by_token_v2(p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  -- Job-linked invoice - full itemized breakdown + claim history, as before.
  select jsonb_build_object(
    'invoice', (to_jsonb(inv) - 'xero_invoice_id' - 'xero_invoice_status' - 'created_by')
      || jsonb_build_object('balance_due', calculate_balance_due(inv.labour_amount, inv.material_amount, inv.stc_amount)),
    'cost_centre', jsonb_build_object('id', cc.id, 'name', cc.name, 'quoted_amount', cc.quoted_amount, 'stc_total', cc.stc_total),
    'project', jsonb_build_object(
      'name', p.name, 'job_number', p.job_number, 'client_name', p.client_name,
      'client_address', p.client_address, 'client_email', p.client_email
    ),
    'client', jsonb_build_object('client_type', cl.client_type),
    'line_items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost, 'sort_order', li.sort_order
      ) order by li.sort_order), '[]'::jsonb)
      from cost_centre_line_items li where li.cost_centre_id = cc.id
    ),
    'company', to_jsonb(cs),
    'previous_claims', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'invoice_number', i2.invoice_number, 'labour_amount', i2.labour_amount,
        'material_amount', i2.material_amount, 'stc_amount', i2.stc_amount, 'sent_at', i2.sent_at
      ) order by i2.sent_at), '[]'::jsonb)
      from invoices i2 where i2.cost_centre_id = cc.id and i2.sent_at < inv.sent_at
    )
  )
  into result
  from invoices inv
  join cost_centres cc on cc.id = inv.cost_centre_id
  join projects p on p.id = cc.project_id
  left join clients cl on cl.id = p.client_id
  cross join company_settings cs
  where inv.invoice_token = p_token and inv.cost_centre_id is not null and cs.id = 1;

  if result is not null then
    return result;
  end if;

  -- Standalone invoice - no stage, no job, no claim history. Client comes
  -- straight from invoices.client_id instead of via a project.
  select jsonb_build_object(
    'invoice', (to_jsonb(inv) - 'xero_invoice_id' - 'xero_invoice_status' - 'created_by')
      || jsonb_build_object('balance_due', calculate_balance_due(inv.labour_amount, inv.material_amount, inv.stc_amount)),
    'cost_centre', jsonb_build_object('name', coalesce(inv.description, 'Invoice'), 'quoted_amount', null, 'stc_total', 0),
    'project', jsonb_build_object(
      'name', null, 'job_number', null, 'client_name', cl.name,
      'client_address', cl.address, 'client_email', cl.email
    ),
    'client', jsonb_build_object('client_type', cl.client_type),
    'line_items', '[]'::jsonb,
    'company', to_jsonb(cs),
    'previous_claims', '[]'::jsonb
  )
  into result
  from invoices inv
  left join clients cl on cl.id = inv.client_id
  cross join company_settings cs
  where inv.invoice_token = p_token and inv.cost_centre_id is null and cs.id = 1;

  return result;
end;
$$;

