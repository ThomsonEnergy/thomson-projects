-- Migration 078 — Re-harden sensitive profile column access
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- An access audit found every sensitive profiles column - pay rates,
-- TFN, address, super, and bank details - still had raw SELECT granted
-- to `authenticated` (and even `anon`), despite migrations 060 and 065
-- intending to revoke exactly this. Something re-granted table-wide
-- SELECT after those ran (most likely Supabase's own schema tooling, or
-- a manual grant against the whole table, which re-applies to every
-- column regardless of an earlier column-specific revoke). Net effect:
-- any logged-in staff member - not just admin/finance - could read
-- every other employee's TFN, bank account, and pay rate directly from
-- the base table, entirely bypassing the *_secure views the app's own
-- code relies on.
--
-- Bank account fields were never covered by any revoke at all (an
-- original design gap, not drift) - added to profiles_sensitive_secure
-- and revoked here for the first time. Same for this session's new
-- residential_suburb/state/postcode columns, which were added without
-- extending the existing residential_address revoke to match.
--
-- New columns appended at the end - Postgres won't let CREATE OR REPLACE
-- VIEW reorder or insert into the middle of an existing column list.
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
  case when can_view_sensitive_profile_data(id) then bank_account_number else null::text end as bank_account_number
from profiles;

revoke select (
  ordinary_rate, rate_1_5x, rate_2x, rate_2_5x,
  tax_file_number, residential_address, residential_suburb, residential_state, residential_postcode,
  super_fund_abn, super_member_number, smsf_abn, smsf_bank_bsb, smsf_bank_account, smsf_esa,
  emergency_contact_phone, bank_account_name, bank_bsb, bank_account_number
) on profiles from authenticated, anon;
