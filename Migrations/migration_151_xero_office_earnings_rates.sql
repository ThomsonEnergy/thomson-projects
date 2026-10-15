-- Migration 151 - "Office" earnings rate per pay band
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Each pay band now has two Xero earnings rates: the existing
-- xero_*_earnings_rate_id columns are the "Jobs" rates (Xero account in
-- Direct Costs) and these new columns are the "Office" rates (Xero account
-- in Overheads). push-timesheets-to-xero.js sends job hours to the Jobs
-- rate and all other hours (admin, quoting, maintenance, TAFE, training) to
-- the Office rate, so job labour sits above gross profit and the rest below.
-- push-pay-rates-to-xero.js puts the same per-person $/hr on both lines.

alter table company_settings add column if not exists xero_ordinary_office_earnings_rate_id text;
alter table company_settings add column if not exists xero_ot1_office_earnings_rate_id text;
alter table company_settings add column if not exists xero_ot2_office_earnings_rate_id text;
alter table company_settings add column if not exists xero_public_holiday_office_earnings_rate_id text;
