-- Migration 150 - Remember which pay rates were last pushed to Xero
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Each employee's 4 contract rates (ordinary_rate, rate_1_5x, rate_2x,
-- rate_2_5x) are now pushed from the app into their Xero Payroll pay
-- template (push-pay-rates-to-xero.js). These two columns record what was
-- sent and when, so Settings > Users & Roles can flag anyone whose rates
-- changed (e.g. a pay rise) but have not been pushed to Xero yet.
-- Written only by the Netlify function with the service role.

alter table profiles add column if not exists xero_rates_pushed jsonb;
alter table profiles add column if not exists xero_rates_pushed_at timestamptz;
