-- Migration 035 — BPAY details on suppliers
-- Run this in Supabase: SQL Editor > New query > paste > Run.
-- A separate payment method from bank transfer - Biller Code + Reference,
-- shown on invoices like the MMEM group's (Haymans/Greentech/TLE).

alter table suppliers add column if not exists bpay_biller_code text;
alter table suppliers add column if not exists bpay_reference text;
