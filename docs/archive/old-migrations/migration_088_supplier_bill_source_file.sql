-- Migration 088 — Keep the original uploaded invoice against a supplier bill
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The bill review/confirm flow (supplier-detail.html) extracts data from
-- an uploaded invoice then discards the file itself once confirmed -
-- there was never anywhere to put it. The sibling statement-upload flow
-- already keeps its source file (supplier_statements.file_path); bills
-- should too, so the original scan/PDF can still be pulled up later.

alter table supplier_bills add column if not exists file_path text;
alter table supplier_bills add column if not exists file_name text;
