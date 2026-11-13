-- Migration 065 — Employee onboarding + Xero Payroll export
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Adds the fields Xero Payroll actually needs to pay someone (TFN, DOB,
-- address, super fund/SMSF, emergency contact - bank details already
-- exist), a small admin-managed set of documents (contract/policies)
-- staff review and sign during onboarding, and tracking for whether that
-- employee has since been pushed to Xero Payroll.

-- 1. New profile fields ------------------------------------------------

alter table profiles add column if not exists date_of_birth date;
alter table profiles add column if not exists tax_file_number text;
alter table profiles add column if not exists residential_address text;
alter table profiles add column if not exists super_fund_name text;
alter table profiles add column if not exists super_fund_abn text;
alter table profiles add column if not exists super_member_number text;
alter table profiles add column if not exists super_is_self_managed boolean not null default false;
alter table profiles add column if not exists smsf_abn text;
alter table profiles add column if not exists smsf_bank_bsb text;
alter table profiles add column if not exists smsf_bank_account text;
alter table profiles add column if not exists smsf_esa text;
alter table profiles add column if not exists emergency_contact_name text;
alter table profiles add column if not exists emergency_contact_phone text;
alter table profiles add column if not exists emergency_contact_relationship text;
alter table profiles add column if not exists employment_start_date date;
alter table profiles add column if not exists employment_type text;
alter table profiles drop constraint if exists profiles_employment_type_check;
alter table profiles add constraint profiles_employment_type_check
  check (employment_type is null or employment_type in ('full_time', 'part_time', 'casual'));

-- Drives which Remuneration clause options get selected when generating
-- this person's employment contract draft (see part 6 below) - some
-- staff are hourly (the only pay structure the rest of this app already
-- understands, via ordinary_rate etc.), some are salaried.
alter table profiles add column if not exists pay_type text not null default 'hourly';
alter table profiles drop constraint if exists profiles_pay_type_check;
alter table profiles add constraint profiles_pay_type_check check (pay_type in ('hourly', 'salary'));
alter table profiles add column if not exists annual_salary numeric;
alter table profiles add column if not exists salary_includes_super boolean not null default true;
alter table profiles add column if not exists has_company_vehicle boolean not null default false;

alter table profiles add column if not exists onboarding_completed_at timestamptz;
alter table profiles add column if not exists xero_payroll_status text not null default 'pending';
alter table profiles drop constraint if exists profiles_xero_payroll_status_check;
alter table profiles add constraint profiles_xero_payroll_status_check
  check (xero_payroll_status in ('pending', 'synced', 'failed'));
alter table profiles add column if not exists xero_payroll_error text;

-- Backfill: without this, every existing active staff member would get
-- force-redirected into the onboarding wizard on their next login.
update profiles set onboarding_completed_at = now()
where onboarding_completed_at is null and active = true;

-- 2. Mask the new sensitive fields, same rule as pay rates --------------
-- (admin/finance, or the row's own owner) - reusing the existing
-- can_view_pay_rates() function via a thin wrapper rather than renaming
-- it, since a function literally named "pay rates" gating TFN/address
-- would confuse future readers.

create or replace function can_view_sensitive_profile_data(p_profile_id uuid)
returns boolean language sql security definer stable as $$
  select can_view_pay_rates(p_profile_id);
$$;

drop view if exists profiles_sensitive_secure;
create view profiles_sensitive_secure with (security_invoker = false) as
select id,
  case when can_view_sensitive_profile_data(id) then tax_file_number else null end as tax_file_number,
  case when can_view_sensitive_profile_data(id) then residential_address else null end as residential_address,
  case when can_view_sensitive_profile_data(id) then super_fund_abn else null end as super_fund_abn,
  case when can_view_sensitive_profile_data(id) then super_member_number else null end as super_member_number,
  case when can_view_sensitive_profile_data(id) then smsf_abn else null end as smsf_abn,
  case when can_view_sensitive_profile_data(id) then smsf_bank_bsb else null end as smsf_bank_bsb,
  case when can_view_sensitive_profile_data(id) then smsf_bank_account else null end as smsf_bank_account,
  case when can_view_sensitive_profile_data(id) then smsf_esa else null end as smsf_esa,
  case when can_view_sensitive_profile_data(id) then emergency_contact_phone else null end as emergency_contact_phone
from profiles;
grant select on profiles_sensitive_secure to authenticated;

revoke select (
  tax_file_number, residential_address, super_fund_abn, super_member_number,
  smsf_abn, smsf_bank_bsb, smsf_bank_account, smsf_esa, emergency_contact_phone
) on profiles from authenticated;

-- 3. Onboarding documents (contract/policies) ----------------------------

create table if not exists onboarding_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  is_required boolean not null default true,
  is_contract boolean not null default false, -- true for exactly one row: the raw employment contract TEMPLATE (with [bracket] placeholders), never signed directly - see employee_contracts below
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table onboarding_documents enable row level security;
drop policy if exists "staff can view onboarding documents" on onboarding_documents;
create policy "staff can view onboarding documents" on onboarding_documents
  for select to authenticated using (true);
drop policy if exists "admins can manage onboarding documents" on onboarding_documents;
create policy "admins can manage onboarding documents" on onboarding_documents
  for all to authenticated using (is_admin()) with check (is_admin());

-- 4. Signed onboarding documents ------------------------------------------
-- A personal legal attestation, not job-scoped like variations - only the
-- signer (or admin/finance) can see it, not "any authenticated" staff.
-- Snapshots the document's title/body text at signing time, so editing a
-- policy later doesn't retroactively change what a past signature attests to.

create table if not exists onboarding_document_signatures (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  document_id uuid references onboarding_documents(id) on delete set null,
  document_title_snapshot text not null,
  document_body_snapshot text not null,
  signature_data_url text not null,
  signed_by_name text not null,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table onboarding_document_signatures enable row level security;
drop policy if exists "own signatures or admin/finance" on onboarding_document_signatures;
create policy "own signatures or admin/finance" on onboarding_document_signatures
  for select to authenticated using (can_view_sensitive_profile_data(profile_id));
drop policy if exists "staff can sign their own onboarding documents" on onboarding_document_signatures;
create policy "staff can sign their own onboarding documents" on onboarding_document_signatures
  for insert to authenticated with check (profile_id = auth.uid());

-- 5. Employment contract drafts -------------------------------------------
-- The contract template has [bracket] placeholders and clause blocks that
-- vary by employment_type/pay_type/has_company_vehicle - auto-filled from
-- the profile, but always reviewed/edited by an admin (status flips to
-- ready_to_sign) before the new hire ever sees it in onboarding.

create table if not exists employee_contracts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade unique, -- one contract record per person; upserted on regenerate
  generated_body text not null default '',
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table employee_contracts drop constraint if exists employee_contracts_status_check;
alter table employee_contracts add constraint employee_contracts_status_check
  check (status in ('draft', 'ready_to_sign', 'signed'));

alter table employee_contracts enable row level security;
drop policy if exists "own contract or admin/finance" on employee_contracts;
create policy "own contract or admin/finance" on employee_contracts
  for select to authenticated using (can_view_sensitive_profile_data(profile_id));
drop policy if exists "admins manage employee contracts" on employee_contracts;
create policy "admins manage employee contracts" on employee_contracts
  for all to authenticated using (is_admin()) with check (is_admin());
-- The employee themself only ever reads their contract (to sign it via
-- onboarding_document_signatures above) - generating/editing the draft
-- and flipping it to ready_to_sign is an admin-only action.
