-- Migration 016 — Xero integration (invoicing + payroll)
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Xero account/tax mapping ------------------------------------------------
-- One row per line-item category used in quotes. Locks which Xero account
-- code and tax type a category is allowed to post as, so a mismatched
-- combination gets caught before it ever reaches Xero.

create table if not exists xero_account_mapping (
  id uuid primary key default gen_random_uuid(),
  category text not null unique,       -- e.g. 'labour', 'materials', 'stc_credits'
  label text not null,                 -- friendly name shown in Settings
  xero_account_code text not null,
  xero_tax_type text not null,
  created_at timestamptz not null default now()
);

alter table xero_account_mapping enable row level security;
drop policy if exists "Pricing roles manage Xero mapping" on xero_account_mapping;
create policy "Pricing roles manage Xero mapping" on xero_account_mapping
  for all using (is_pricing_role()) with check (is_pricing_role());

-- Seed the two most common categories so there's something to edit rather
-- than an empty table. Placeholder codes - replace with real ones from the
-- demo company's chart of accounts before actually pushing anything.
insert into xero_account_mapping (category, label, xero_account_code, xero_tax_type)
values
  ('labour', 'Labour Income', '200', 'OUTPUT2'),
  ('materials', 'Materials / Trading Income', '260', 'OUTPUT2')
on conflict (category) do nothing;

-- 2. Link staff to their Xero Payroll employee record -----------------------

alter table profiles add column if not exists xero_employee_id text;

-- 3. Track what's already been pushed, so nothing gets double-sent --------

alter table projects add column if not exists xero_contact_id text;

alter table cost_centres add column if not exists xero_invoice_id text;
alter table cost_centres add column if not exists xero_invoice_status text;

-- The invoice is created and sent from the app itself - the client never
-- sees Xero. Xero gets these same numbers afterward, purely as the
-- bookkeeper's accounting record.
alter table cost_centres add column if not exists invoice_number text;
alter table cost_centres add column if not exists invoice_token uuid;
alter table cost_centres add column if not exists invoice_sent_at timestamptz;
alter table cost_centres add column if not exists invoice_paid_at timestamptz;
alter table cost_centres add column if not exists invoice_labour_amount numeric;
alter table cost_centres add column if not exists invoice_material_amount numeric;

-- Public, token-based read of a single invoice - same pattern as the
-- existing get_quote_by_token, bypasses RLS via security definer so a
-- client with the link (and only that link) can view it without logging in.
create or replace function get_invoice_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'cost_centre', to_jsonb(cc) - 'xero_invoice_id' - 'xero_invoice_status',
    'project', jsonb_build_object(
      'name', p.name, 'job_number', p.job_number, 'client_name', p.client_name,
      'client_address', p.client_address, 'client_email', p.client_email
    ),
    'company', to_jsonb(cs)
  )
  into result
  from cost_centres cc
  join projects p on p.id = cc.project_id
  cross join company_settings cs
  where cc.invoice_token = p_token and cs.id = 1;

  return result;
end;
$$;

-- Which pay period a given time_entries batch has already been pushed for,
-- so re-running the push doesn't create duplicate DRAFT timesheets.
alter table time_entries add column if not exists xero_pushed_at timestamptz;

-- 4. Xero tracking category ID for cost centre / job tagging --------------
-- Xero needs a Tracking Category ("Job") with an option per job number to
-- tag invoice lines and payroll timesheets back to a job. Store the
-- category's Xero-side ID once created (created manually in Xero, or via
-- the Accounting API - either way, one ID for the whole system).

alter table company_settings add column if not exists xero_tracking_category_id text;

-- The Xero Payroll AU "Earnings Rate" to use for ordinary hours (e.g.
-- "Ordinary Hours") - Xero doesn't have one universal ID for this, it's
-- configured per organisation, so an admin sets it once here.
alter table company_settings add column if not exists xero_ordinary_earnings_rate_id text;

-- Note: the Xero webhook signing key lives in api_keys (key_name =
-- 'xero_webhook_key'), same as the Client ID/Secret - not a separate
-- column here, kept consistent with how every other third-party secret
-- is stored.

-- Shown on the client-facing invoice (bank details, EFT reference format,
-- etc.) - editable in Settings, not baked into code.
alter table company_settings add column if not exists payment_details_text text
  default 'Please pay via direct deposit using the invoice number as your payment reference.';
