-- Migration 081 — Xero earnings rates for overtime/public holiday bands
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Timesheets pushed to Xero only ever used one earnings rate (Ordinary
-- Hours) for every hour worked. Payroll already computes proper award
-- bands per day (profiles.ordinary_rate/rate_1_5x/rate_2x/rate_2_5x, see
-- compute-labour-cost.js) but push-timesheets-to-xero.js never told Xero
-- which band an hour fell into - it just paid everything as ordinary time
-- against account 477. Adding one earnings-rate mapping per band lets
-- each rate post to its own Xero account (e.g. 477 ordinary, 477.5 OT1),
-- same one-setting-for-the-whole-company pattern as the existing
-- xero_ordinary_earnings_rate_id.

alter table company_settings add column if not exists xero_ot1_earnings_rate_id text;
alter table company_settings add column if not exists xero_ot2_earnings_rate_id text;
alter table company_settings add column if not exists xero_public_holiday_earnings_rate_id text;
