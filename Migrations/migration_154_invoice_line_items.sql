-- Migration 154 - Items added while building an invoice (do-and-charge jobs)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- On a job with no quote behind it (proposal_template 'direct_job') the
-- invoice builder lets you add Stock materials and prebuilds straight onto
-- the invoice, under one of the cost centres being claimed. Each one is a
-- row here, so there is a record of what was sold on which invoice (and at
-- what cost and price). Its sell value is already folded into that
-- claim's labour_amount / material_amount, so totals, balance due and the
-- Xero push (still one Labour and one Materials line per cost centre) are
-- unchanged - these rows are the detail behind those figures.
--
-- A Stock material also takes the quantity out of the warehouse and is
-- costed to the job through job_material_usage (job_material_usage_id).
-- Prebuild components aren't linked to Stock, so a prebuild is priced only.
--
-- get_invoice_by_token_v3 now returns each claim's items ('invoice_items')
-- so the client's invoice page and PDF list them under the cost centre.

-- create-invoice.js has always sent a null claim_percent for a job with no
-- quote behind it (there's nothing for a % to mean), but the column was
-- NOT NULL, so "Invoice actual costs" on a no-quote job always failed.
alter table invoices alter column claim_percent drop not null;

create table if not exists invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  invoice_claim_id uuid references invoice_claims(id) on delete cascade,
  cost_centre_id uuid references cost_centres(id) on delete set null,
  kind text not null check (kind in ('material', 'prebuild')),
  material_id uuid references materials(id) on delete set null,
  prebuild_id uuid references prebuilds(id) on delete set null,
  description text not null,
  quantity numeric not null,
  unit_cost numeric not null default 0,   -- what it cost us, ex GST
  unit_price numeric not null default 0,  -- what the client is charged, ex GST
  labour_amount numeric not null default 0,   -- this row's share of the claim's labour (prebuild labour components)
  material_amount numeric not null default 0, -- this row's share of the claim's materials
  job_material_usage_id uuid references job_material_usage(id) on delete set null,
  sort_order integer not null default 0,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists invoice_line_items_invoice_idx on invoice_line_items(invoice_id);
create index if not exists invoice_line_items_claim_idx on invoice_line_items(invoice_claim_id);

alter table invoice_line_items enable row level security;
drop policy if exists "Pricing roles manage invoice line items" on invoice_line_items;
create policy "Pricing roles manage invoice line items" on invoice_line_items
  for all using (is_pricing_role()) with check (is_pricing_role());

create or replace function public.get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      'client_email', p.client_email,
      'proposal_template', p.proposal_template
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
      ), '[]'::jsonb),
      'invoice_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', ili.kind, 'description', ili.description, 'quantity', ili.quantity,
          'unit_price', ili.unit_price, 'labour_amount', ili.labour_amount, 'material_amount', ili.material_amount
        ) order by ili.sort_order, ili.created_at)
        from invoice_line_items ili where ili.invoice_claim_id = ic.id
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
      ), '[]'::jsonb),
      'invoice_items', '[]'::jsonb
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
$function$;
