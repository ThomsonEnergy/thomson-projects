-- Migration 021 — User profile screen: mobile, photo, notes, licences
-- Run this in Supabase: SQL Editor > New query > paste > Run.

alter table profiles add column if not exists mobile_number text;
alter table profiles add column if not exists notes text;
alter table profiles add column if not exists photo_url text;

-- Structured bank details, shown on the client invoice alongside the
-- freeform payment_details_text already in place. Payment reference is
-- always the invoice number itself - no separate field needed for that.
alter table company_settings add column if not exists bank_name text;
alter table company_settings add column if not exists bank_account_name text;
alter table company_settings add column if not exists bank_bsb text;
alter table company_settings add column if not exists bank_account_number text;

create table if not exists profile_licences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  licence_name text not null,
  licence_number text,
  expiry_date date,
  created_at timestamptz not null default now()
);

alter table profile_licences enable row level security;
drop policy if exists "Admin manages licences" on profile_licences;
create policy "Admin manages licences" on profile_licences
  for all using (is_admin()) with check (is_admin());
