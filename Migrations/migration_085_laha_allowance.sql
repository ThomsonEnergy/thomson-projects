-- Migration 085 — LAHA (living away from home allowance)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Jobs more than 100km from base already get a Mobilisation cost centre
-- covering travel/LAHA in the quote. This lets that job be flagged as
-- LAHA-approved so staff clocking out of it get asked whether they
-- stayed overnight, and pushes a nightly allowance line to Xero for
-- every night flagged - same mechanism as the ordinary/OT/public holiday
-- earnings rates already pushed (see push-timesheets-to-xero.js), just a
-- units-are-nights-not-hours rate instead of an hourly one.

alter table projects add column if not exists laha_approved boolean not null default false;
alter table time_entries add column if not exists stayed_overnight boolean;
alter table company_settings add column if not exists xero_laha_earnings_rate_id text;
