-- Migration 077 — Structured residential address
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Xero Payroll AU's Employees endpoint requires HomeAddress as separate
-- Suburb/State/Postcode fields, not one free-text line (confirmed from
-- its own validation error: "The Postcode is required.", "The Suburb is
-- required.", "The State is required." when only AddressLine1 was sent).
-- residential_address now holds just the street line; existing values
-- (which held the whole address as one string) aren't auto-split - not
-- reliable to guess street vs suburb boundaries from free text - so
-- existing profiles need a manual once-over the next time this is
-- reviewed, same as anyone re-issued through onboarding already gets.

alter table profiles add column if not exists residential_suburb text;
alter table profiles add column if not exists residential_state text;
alter table profiles add column if not exists residential_postcode text;

-- New columns appended at the end (Postgres won't let CREATE OR REPLACE
-- VIEW reorder or insert into the middle of an existing column list).
create or replace view profiles_sensitive_secure as
select id,
  case when can_view_sensitive_profile_data(id) then tax_file_number else null::text end as tax_file_number,
  case when can_view_sensitive_profile_data(id) then residential_address else null::text end as residential_address,
  case when can_view_sensitive_profile_data(id) then super_fund_abn else null::text end as super_fund_abn,
  case when can_view_sensitive_profile_data(id) then super_member_number else null::text end as super_member_number,
  case when can_view_sensitive_profile_data(id) then smsf_abn else null::text end as smsf_abn,
  case when can_view_sensitive_profile_data(id) then smsf_bank_bsb else null::text end as smsf_bank_bsb,
  case when can_view_sensitive_profile_data(id) then smsf_bank_account else null::text end as smsf_bank_account,
  case when can_view_sensitive_profile_data(id) then smsf_esa else null::text end as smsf_esa,
  case when can_view_sensitive_profile_data(id) then emergency_contact_phone else null::text end as emergency_contact_phone,
  case when can_view_sensitive_profile_data(id) then residential_suburb else null::text end as residential_suburb,
  case when can_view_sensitive_profile_data(id) then residential_state else null::text end as residential_state,
  case when can_view_sensitive_profile_data(id) then residential_postcode else null::text end as residential_postcode
from profiles;
