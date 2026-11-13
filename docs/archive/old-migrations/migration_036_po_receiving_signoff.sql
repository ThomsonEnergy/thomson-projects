-- Migration 036 — PO receiving sign-off, stock-level POs
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Separates "we got an invoice for this" from "we actually approve
-- paying it" - approval now requires someone to explicitly confirm every
-- item on the PO has physically arrived, not just that a bill exists.
-- Also allows a PO to exist without any job at all, for general stock
-- replenishment rather than a specific project.

alter table purchase_orders alter column project_id drop not null;
alter table purchase_orders add column if not exists received boolean not null default false;
alter table purchase_orders add column if not exists received_by uuid references profiles(id);
alter table purchase_orders add column if not exists received_at timestamptz;
