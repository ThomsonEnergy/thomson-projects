-- Migration 080 — Xero payroll calendar mapping
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- An employee can't have timesheets or pay runs in Xero without a Pay
-- Calendar assigned (found when the first real timesheet push came back
-- "employee doesn't have payrun calendar"). Same one-default-for-the-
-- whole-company pattern as xero_ordinary_earnings_rate_id, since a small
-- business is very unlikely to run more than one pay cycle.

alter table company_settings add column if not exists xero_payroll_calendar_id text;
