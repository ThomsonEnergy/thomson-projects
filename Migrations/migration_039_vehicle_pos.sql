-- Migration 039 — Vehicle-assigned purchase orders
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- A PO can now be assigned to a vehicle instead of a job or general
-- stock. Two flavours, distinguished by whether a supplier is set:
-- no supplier = pulling straight from Warehouse stock (physically at the
-- shed, grabbing what's already there); a real supplier = an actual
-- purchase that arrives directly to that vehicle, same "bypasses
-- general stock" pattern already used for job-specific POs.

alter table purchase_orders add column if not exists vehicle_id uuid references fleet_vehicles(id);
