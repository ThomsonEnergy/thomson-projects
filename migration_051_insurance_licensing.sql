-- Insurance & Licensing.
--
-- Company-level insurance policies and business licences (Public Liability,
-- Electrical Contractor's Licence, etc.) - a new table, since the only
-- existing company "licences" field (company_settings.licenses) is a single
-- free-text line with no expiry date or certificate attached.
--
-- Employee licences already exist as `profile_licences` (name/number/expiry),
-- managed from each user's Settings > Users > Profile screen - that table
-- isn't in any committed migration (created directly against the live DB
-- in an earlier session), so this only ALTERs it to add certificate file
-- columns rather than trying to (re)create it.

create table if not exists company_credentials (
  id uuid primary key default gen_random_uuid(),
  credential_type text not null default 'insurance' check (credential_type in ('insurance', 'licence')),
  name text not null, -- e.g. "Public Liability Insurance" or "QLD Electrical Contractor Licence"
  provider text, -- insurer name, or the licensing body
  reference_number text, -- policy number / licence number
  expiry_date date,
  file_path text,
  file_name text,
  created_at timestamptz not null default now()
);

create index if not exists company_credentials_expiry_idx on company_credentials (expiry_date);

alter table company_credentials enable row level security;
drop policy if exists "staff full access on company_credentials" on company_credentials;
create policy "staff full access on company_credentials"
  on company_credentials for all to authenticated using (true) with check (true);

-- Certificate attachment for an employee's licence, so "upload a Certificate
-- of Currency and let AI read it" works the same way for a person's own
-- licence (e.g. their electrician's licence) as it does for a company policy.
alter table profile_licences add column if not exists file_path text;
alter table profile_licences add column if not exists file_name text;
