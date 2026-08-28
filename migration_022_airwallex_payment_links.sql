-- Migration 022 — Airwallex Payment Links
-- Run this in Supabase: SQL Editor > New query > paste > Run.

alter table invoices add column if not exists airwallex_payment_link_id text;
alter table invoices add column if not exists airwallex_payment_link_url text;
