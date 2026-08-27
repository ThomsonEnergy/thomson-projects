-- Multi-stage invoicing: one invoice, multiple stage-claim lines, so a
-- single claim can cover the whole project (0-100% of total contract
-- value) or a hand-picked set of cost centres, instead of being locked to
-- exactly one stage per invoice.
--
-- Existing invoices are untouched and keep working as-is (they still carry
-- their own cost_centre_id + labour/material/stc amounts directly). New
-- invoices raised after this migration always go through invoice_claims
-- instead, one row per cost centre included in that claim - the invoice's
-- own labour_amount/material_amount/stc_amount columns are kept as the SUM
-- across its claims, so get_invoice_balance_due(), the Xero push, and the
-- Invoices list page all keep working unchanged off those totals.

alter table invoices add column if not exists project_id uuid references projects(id) on delete cascade;

-- Backfill project_id onto every existing job-linked invoice, so "which
-- invoices belong to this project" can be answered directly instead of
-- via a join through cost_centres - this is also what the client-facing
-- get_invoice_by_token_v3() function below groups "previous claims" by.
update invoices set project_id = cc.project_id
from cost_centres cc
where invoices.cost_centre_id = cc.id and invoices.project_id is null;

create table if not exists invoice_claims (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  claim_percent numeric(6,2),
  labour_amount numeric(12,2) not null default 0,
  material_amount numeric(12,2) not null default 0,
  stc_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists invoice_claims_invoice_id_idx on invoice_claims (invoice_id);
create index if not exists invoice_claims_cost_centre_id_idx on invoice_claims (cost_centre_id);

alter table invoice_claims enable row level security;
drop policy if exists "staff full access on invoice_claims" on invoice_claims;
create policy "staff full access on invoice_claims"
  on invoice_claims for all to authenticated using (true) with check (true);

-- Public, token-gated read used by the client-facing invoice page
-- (invoice.html). Mirrors whatever get_invoice_by_token_v2() already does
-- for old single-stage invoices (untouched, left in place), but also
-- understands invoice_claims so a multi-stage invoice can show a
-- breakdown of which section is being invoiced and how much per section.
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
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.sent_at < v_invoice.sent_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.sent_at < v_invoice.sent_at
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
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.sent_at < v_invoice.sent_at
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
      and i.sent_at < v_invoice.sent_at;
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
