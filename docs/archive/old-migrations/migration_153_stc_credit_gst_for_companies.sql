-- Migration 153 - STC credit includes GST for company clients
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- stc_amount (on invoices, invoice_claims, credit_note_claims) and
-- cost_centres.stc_total stay what they always were: the STC value ex GST
-- (certificates x booked price), the same figure the Xero push sends as an
-- exclusive line with the mapping's tax type. Xero then credits:
--   individual: $1,750, no GST (BAS Excluded)      -> customer pays $9,250
--   company:    $1,750 + $175 GST = $1,925 (OUTPUT) -> customer pays $9,075
-- (worked example: $10,000 + GST job, 50 STCs at $35). The app subtracted
-- a flat $1,750 for everyone, so for company clients the quote, invoice,
-- balance due and card payment link were $175 higher than Xero.
--
-- stc_credit_inc_gst() is now the one place that grosses the credit up for
-- companies; balance due, the public invoice page and the public quote page
-- all go through it.

create or replace function stc_credit_inc_gst(p_stc numeric, p_client_type text)
returns numeric
language sql
immutable
as $$
  select case when p_client_type = 'company'
    then round(coalesce(p_stc, 0) * 1.10, 2)
    else coalesce(p_stc, 0)
  end;
$$;

-- An invoice's client: its own client_id (standalone invoices), else the
-- job's client via project_id or the stage's project. Defaults to
-- 'individual', matching build-xero-invoice-payload.js.
create or replace function invoice_client_type(p_invoice_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select cl.client_type
       from invoices i
       left join cost_centres cc on cc.id = i.cost_centre_id
       left join projects p on p.id = coalesce(i.project_id, cc.project_id)
       left join clients cl on cl.id = coalesce(i.client_id, p.client_id)
      where i.id = p_invoice_id),
    'individual');
$$;

create or replace function calculate_balance_due(p_labour numeric, p_material numeric, p_stc numeric, p_client_type text)
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
  return subtotal + gst - stc_credit_inc_gst(p_stc, p_client_type);
end;
$$;

-- The original 3-argument version is kept (as an individual client) for
-- anything still calling it, e.g. get_invoice_by_token_v2.
create or replace function calculate_balance_due(p_labour numeric, p_material numeric, p_stc numeric)
returns numeric
language sql
security definer
as $$
  select calculate_balance_due(p_labour, p_material, p_stc, 'individual');
$$;

create or replace function get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
as $$
declare
  inv record;
  credited record;
begin
  select labour_amount, material_amount, stc_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) as stc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  return calculate_balance_due(
    inv.labour_amount - credited.labour,
    inv.material_amount - credited.material,
    inv.stc_amount - credited.stc,
    invoice_client_type(p_invoice_id)
  );
end;
$$;

-- Same as before, plus client_type and stc_credit_inc_gst on the invoice,
-- so the public invoice page shows the credit the way Xero has it.
create or replace function get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
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
  v_client_type text;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  v_client_type := invoice_client_type(v_invoice.id);
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
          union all
          select -(cnc.labour_amount + cnc.material_amount)
          from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
          where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
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
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
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
    'invoice', to_jsonb(v_invoice) || jsonb_build_object(
      'balance_due', v_balance,
      'client_type', v_client_type,
      'stc_credit_inc_gst', stc_credit_inc_gst(v_invoice.stc_amount, v_client_type)
    ),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;

-- Same as before, plus client_type, so the quote page can show a company
-- client's STC credit including GST.
create or replace function get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
as $$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
    'client_type', coalesce((select cl.client_type from clients cl where cl.id = p.client_id), 'individual'),
    'prepared_by', (select pr.full_name from profiles pr where pr.id = p.created_by),
    'cost_centres', (
      select coalesce(json_agg(
        json_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'is_variation', (c.variation_entry_id is not null),
          'variation_reason', ve.reason,
          'photo_groups', (
            select coalesce(json_agg(
              json_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::json)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            select coalesce(json_agg(
              json_build_object('description', li.description, 'amount', li.amount, 'quantity', li.quantity, 'item_type', li.item_type)
              order by li.sort_order
            ), '[]'::json)
            from (
              select cli.description as description,
                (case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                      else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                 end) as amount,
                cli.quantity as quantity,
                cli.item_type as item_type,
                cli.sort_order as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is null

              union all

              select max(cli.prebuild_client_description) as description,
                sum(case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                         else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                    end) as amount,
                (array_agg(cli.quantity / nullif(cli.prebuild_base_quantity, 0) order by cli.sort_order))[1] as quantity,
                null::text as item_type,
                min(cli.sort_order) as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is not null
              group by cli.prebuild_group_id
            ) li
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c
      left join job_variation_entries ve on ve.id = c.variation_entry_id
      where c.project_id = p.id
        and (c.variation_entry_id is null or (ve.variation_type = 'fixed' and ve.approval_status = 'approved'))
    ),
    'payment_milestones', (
      select coalesce(json_agg(
        json_build_object('label', m.label, 'percent', m.percent)
        order by m.sort_order
      ), '[]'::json)
      from payment_milestones m where m.project_id = p.id
    ),
    'schedule_of_rates', (
      case when p.proposal_template = 'quick_estimate' then (
        select coalesce(json_agg(
          json_build_object('name', t.name, 'sell_rate', t.sell_rate)
          order by t.sort_order
        ), '[]'::json)
        from billable_rate_tiers t
      ) else null end
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$$;

grant execute on function stc_credit_inc_gst(numeric, text) to anon, authenticated;
grant execute on function calculate_balance_due(numeric, numeric, numeric, text) to anon, authenticated;
grant execute on function get_invoice_by_token_v3(uuid) to anon, authenticated;
grant execute on function get_quote_by_token(text) to anon, authenticated;
grant execute on function get_invoice_balance_due(uuid) to anon, authenticated;
