-- Fixes the invoice "claim breakdown" showing wrong claimed-before/remaining
-- amounts and percentages.
--
-- Root cause: get_invoice_by_token_v3() decided which invoices count as
-- "before" the one being viewed by comparing sent_at - but sent_at is a
-- date the app either sets automatically to the exact creation moment (a
-- deposit invoice, raised the instant a quote's accepted, gets something
-- like 03:35:00) or that a staff member picks from a plain date field when
-- manually creating a progress/final claim (which lands on that date's
-- midnight, 00:00:00). Real example that surfaced this: a deposit raised
-- at 03:35am, then a progress claim created later that same day with its
-- invoice date left at today - its sent_at (00:00:00) sorts BEFORE the
-- deposit's (03:35:00) even though the deposit genuinely came first. The
-- progress claim's own breakdown then failed to count the deposit as
-- "claimed before" it, and the deposit's breakdown wrongly counted the
-- later progress claim as coming before it instead.
--
-- Fix: use created_at (set once at insert, never edited by the app) to
-- decide ordering instead of sent_at (a user-editable display date, and
-- often backdated on purpose). sent_at stays exactly what's printed on
-- the invoice as its date - this only changes which invoices count as
-- "earlier" for the claimed-before/remaining math.

create or replace function get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_company jsonb;
  v_project jsonb;
  v_claims jsonb := '[]'::jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_balance numeric;
  v_is_standalone boolean;
  v_project_id uuid;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  select to_jsonb(cs) - 'id' into v_company from company_settings cs where id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_email', p.client_email
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_email', c.email)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'stc_amount', ic.stc_amount,
      'claimed_before', coalesce((
        select sum(x.amt) from (
          select ic2.labour_amount + ic2.material_amount as amt
          from invoice_claims ic2 join invoices i2 on i2.id = ic2.invoice_id
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.created_at < v_invoice.created_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
            and not exists (select 1 from invoice_claims ic3 where ic3.invoice_id = i3.id)
        ) x
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb)
    ) order by cc.sort_order)
    into v_claims
    from invoice_claims ic join cost_centres cc on cc.id = ic.cost_centre_id
    where ic.invoice_id = v_invoice.id;
  elsif v_invoice.cost_centre_id is not null then
    select jsonb_build_array(jsonb_build_object(
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb)
    ))
    into v_claims
    from cost_centres cc where cc.id = v_invoice.cost_centre_id;
  end if;

  if not v_is_standalone then
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', i.invoice_number,
      'sent_at', i.sent_at,
      'amount', i.labour_amount + i.material_amount
    ) order by i.sent_at), '[]'::jsonb)
    into v_previous
    from invoices i
    where i.id <> v_invoice.id
      and coalesce(i.project_id, (select cc.project_id from cost_centres cc where cc.id = i.cost_centre_id)) = v_project_id
      and i.created_at < v_invoice.created_at;
  end if;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice) || jsonb_build_object('balance_due', v_balance),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;

grant execute on function get_invoice_by_token_v3(uuid) to anon, authenticated;
