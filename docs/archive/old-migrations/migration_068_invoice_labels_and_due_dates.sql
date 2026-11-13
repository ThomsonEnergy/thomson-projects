-- Migration 068 — Invoice claim labels + due dates
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- invoices.description already existed and was already used for
-- "Deposit" and standalone-invoice descriptions - now also used for
-- "Progress claim N" on job-linked claims, and actually shown/used in
-- the Xero reference instead of stage names.
--
-- due_date is new: computed from the client's payment_terms at creation
-- time (COD = due same day, net_7/14/30 = that many days out), but
-- editable by staff when raising the invoice.

alter table invoices add column if not exists due_date date;
