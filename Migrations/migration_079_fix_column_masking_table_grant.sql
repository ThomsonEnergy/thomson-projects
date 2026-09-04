-- Migration 079 — Fix column masking: it never actually worked
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Migration 078 (and 060, and 065 before it) revoked SELECT on specific
-- sensitive columns of profiles, and it never had any effect: profiles,
-- like every Supabase table, also carries a blanket table-level SELECT
-- grant to authenticated/anon (Supabase's own default for new tables).
-- A column-level REVOKE cannot override a table-level GRANT that still
-- covers the same column - PostgREST only needs ONE grant path to allow
-- a read, and the table-level one was always there. Verified directly:
-- `set local role authenticated; select tax_file_number from profiles;`
-- succeeded before this migration and fails with permission denied after.
--
-- The only way column masking actually works is to revoke SELECT at the
-- table level entirely, then re-grant it for an explicit list of the
-- non-sensitive columns only. anon gets nothing re-granted - RLS already
-- blocks it from every row, and the app never queries profiles
-- unauthenticated anyway.
--
-- Also extends masking to two columns that were never covered by any
-- revoke at all (a design gap, not drift): date_of_birth and
-- annual_salary - the same sensitivity class as TFN/address and
-- ordinary_rate/rate_1_5x/etc respectively.

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
  case when can_view_sensitive_profile_data(id) then residential_postcode else null::text end as residential_postcode,
  case when can_view_sensitive_profile_data(id) then bank_account_name else null::text end as bank_account_name,
  case when can_view_sensitive_profile_data(id) then bank_bsb else null::text end as bank_bsb,
  case when can_view_sensitive_profile_data(id) then bank_account_number else null::text end as bank_account_number,
  case when can_view_sensitive_profile_data(id) then date_of_birth else null::date end as date_of_birth
from profiles;

create or replace view profiles_pay_rates_secure as
select id,
  case when can_view_pay_rates(id) then ordinary_rate else null::numeric end as ordinary_rate,
  case when can_view_pay_rates(id) then rate_1_5x else null::numeric end as rate_1_5x,
  case when can_view_pay_rates(id) then rate_2x else null::numeric end as rate_2x,
  case when can_view_pay_rates(id) then rate_2_5x else null::numeric end as rate_2_5x,
  case when can_view_pay_rates(id) then annual_salary else null::numeric end as annual_salary
from profiles;

revoke select on profiles from authenticated, anon;

grant select (
  id, theme, created_at, role, full_name, active, xero_employee_id, mobile_number, notes, photo_url,
  rate_tier_id, job_title, super_fund_name, super_is_self_managed, emergency_contact_name,
  emergency_contact_relationship, employment_start_date, employment_type, pay_type, salary_includes_super,
  has_company_vehicle, onboarding_completed_at, xero_payroll_status, xero_payroll_error,
  has_probationary_period, onboarding_reissue_reason, onboarding_reissue_note, onboarding_cycle_started_at
) on profiles to authenticated;
