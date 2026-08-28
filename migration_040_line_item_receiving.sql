-- Migration 040 — Per-line-item PO receiving
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Receiving moves from "the whole PO" to each line item individually -
-- each one gets ticked off and sent to wherever it actually needs to go
-- (a job, the Warehouse, or a specific vehicle), not just wherever the
-- PO as a whole defaults to. Covers buying materials for a job and a
-- tool for the van in the same order.

alter table purchase_order_line_items add column if not exists received boolean not null default false;
alter table purchase_order_line_items add column if not exists destination_type text check (destination_type in ('job', 'warehouse', 'vehicle'));
alter table purchase_order_line_items add column if not exists destination_job_id uuid references projects(id);
alter table purchase_order_line_items add column if not exists destination_vehicle_id uuid references fleet_vehicles(id);
alter table purchase_order_line_items add column if not exists received_by uuid references profiles(id);
alter table purchase_order_line_items add column if not exists received_at timestamptz;
