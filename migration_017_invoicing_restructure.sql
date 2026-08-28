-- Migration 017 — Invoicing restructure: multiple claims per stage,
-- job number on approval, client type, STC handling
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Client type - drives STC GST treatment automatically -----------------

alter table clients add column if not exists client_type text not null default 'individual';
alter table clients drop constraint if exists clients_client_type_check;
alter table clients add constraint clients_client_type_check
  check (client_type in ('individual', 'company'));

-- 2. STC entitlement lives on the stage, set at quote time -----------------

alter table cost_centres add column if not exists stc_total numeric not null default 0;

-- 3. Invoices become their own table ----------------------------------------
-- A stage can now be claimed more than once (progressive claims), so
-- invoice details can no longer live as a handful of columns on
-- cost_centres - each invoice is its own row here instead.

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  invoice_number text not null,
  invoice_token uuid not null default gen_random_uuid(),
  labour_amount numeric not null default 0,
  material_amount numeric not null default 0,
  stc_amount numeric not null default 0,       -- STC credit applied on THIS claim (0 if deferred)
  claim_percent numeric not null default 100,  -- % of the stage this claim represents, at time of creation
  sent_at timestamptz not null default now(),
  paid_at timestamptz,
  xero_invoice_id text,
  xero_invoice_status text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table invoices enable row level security;
drop policy if exists "Pricing roles manage invoices" on invoices;
create policy "Pricing roles manage invoices" on invoices
  for all using (is_pricing_role()) with check (is_pricing_role());

-- Public, token-based read for the client-facing invoice page - same
-- pattern as get_quote_by_token.
create or replace function get_invoice_by_token_v2(p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'invoice', to_jsonb(inv) - 'xero_invoice_id' - 'xero_invoice_status' - 'created_by',
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
  where inv.invoice_token = p_token and cs.id = 1;

  return result;
end;
$$;

-- 4. Migrate any existing single-invoice data on cost_centres --------------
-- If migration_016 already ran and someone created an invoice under the
-- old one-per-stage model, carry it across before the old columns go away.

-- Only run this if the old single-invoice columns actually still exist -
-- avoids erroring out on a database where they're already gone for
-- whatever reason. Caught directly via exception handling rather than a
-- pre-check, since that's more reliable regardless of the database's
-- exact history. There's realistically no real invoice data to carry
-- forward yet this early anyway, so skipping cleanly is a safe outcome.
do $$
begin
  begin
    insert into invoices (cost_centre_id, invoice_number, invoice_token, labour_amount, material_amount, sent_at, paid_at, xero_invoice_id, xero_invoice_status, claim_percent)
    select
      cc.id, cc.invoice_number, cc.invoice_token,
      coalesce(cc.invoice_labour_amount, 0), coalesce(cc.invoice_material_amount, 0),
      coalesce(cc.invoice_sent_at, now()), cc.invoice_paid_at, cc.xero_invoice_id, cc.xero_invoice_status,
      100
    from cost_centres cc
    where cc.invoice_number is not null
    on conflict do nothing;
  exception
    when undefined_column then
      raise notice 'Skipping old-invoice carry-forward - cost_centres does not have the old single-invoice columns, nothing to carry forward.';
  end;
end $$;

alter table cost_centres drop column if exists invoice_number;
alter table cost_centres drop column if exists invoice_token;
alter table cost_centres drop column if exists invoice_sent_at;
alter table cost_centres drop column if exists invoice_paid_at;
alter table cost_centres drop column if exists invoice_labour_amount;
alter table cost_centres drop column if exists invoice_material_amount;
alter table cost_centres drop column if exists xero_invoice_id;
alter table cost_centres drop column if exists xero_invoice_status;

-- 5. Job number auto-assigned the moment a quote is approved ---------------
-- Quote number is drawn at creation and never changes. Job number stays
-- null - and the number itself tells you approval status - until the
-- pipeline stage crosses into "approved or beyond", at which point one is
-- drawn automatically. This inlines the same atomic counter increment
-- get_next_number uses, rather than calling that function directly, since
-- it enforces a pricing-role check that doesn't make sense inside a
-- trigger firing as a side effect of a normal stage move.

create or replace function assign_job_number_on_approval()
returns trigger
language plpgsql
security definer
as $$
declare
  approved_stages text[] := array['quote_approved','deposit_paid','ready_to_book','job_booked','job_not_complete','client_handover','awaiting_payment'];
  next_job int;
begin
  if new.job_number is null and new.pipeline_stage = any(approved_stages) then
    update company_settings set next_job_number = next_job_number + 1
      where id = 1
      returning next_job_number - 1 into next_job;
    new.job_number := next_job;
  end if;
  return new;
end;
$$;

drop trigger if exists on_project_stage_change on projects;
create trigger on_project_stage_change
  before insert or update of pipeline_stage on projects
  for each row execute function assign_job_number_on_approval();

-- 6. Real Xero account codes, replacing the earlier placeholders ----------
-- STC credits split by client type (Individual/Company) since the GST
-- treatment differs - see clients.client_type above, which drives which
-- of these two the push-to-Xero function picks automatically.

update xero_account_mapping set xero_account_code = '2001', xero_tax_type = 'OUTPUT2' where category = 'materials';
update xero_account_mapping set xero_account_code = '2002', xero_tax_type = 'OUTPUT2' where category = 'labour';

insert into xero_account_mapping (category, label, xero_account_code, xero_tax_type)
values
  ('stc_credits_individual', 'STC Credits GST Free (Individual)', '2003', 'EXEMPTOUTPUT'),
  ('stc_credits_company', 'STC Credits GST Inc (Company)', '2004', 'OUTPUT2')
on conflict (category) do update set
  xero_account_code = excluded.xero_account_code,
  xero_tax_type = excluded.xero_tax_type;

-- 2005 (STC Trading Variance) isn't posted to programmatically - it's
-- used manually in Xero when reconciling the actual Formbay/STC-buyer
-- payment against what was credited to the customer, per the bank
-- reconciliation approach discussed (split the bank line across the STC
-- asset account and this variance account rather than building an
-- app-side settlement screen, since the app has no visibility into that
-- payment - only Xero does). Recorded here for reference only.
insert into xero_account_mapping (category, label, xero_account_code, xero_tax_type)
values ('stc_trading_variance', 'STC Trading Variance (manual, bank rec only)', '2005', 'OUTPUT2')
on conflict (category) do update set
  xero_account_code = excluded.xero_account_code,
  xero_tax_type = excluded.xero_tax_type;

