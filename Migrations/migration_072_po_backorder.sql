-- Migration 072 — Backorder tracking on PO line items
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Lets a line item be marked backordered with an expected date, instead
-- of only "received" or "not yet received" - so a partially-delayed PO
-- shows what's actually going on rather than just sitting as "pending".

alter table purchase_order_line_items add column if not exists is_backordered boolean not null default false;
alter table purchase_order_line_items add column if not exists backorder_eta date;
