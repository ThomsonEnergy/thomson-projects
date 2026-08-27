-- Fixes: "new row for relation invoices violates check constraint
-- invoices_client_or_stage_check"
--
-- That constraint (not in any prior migration file - it predates version
-- control on this table) required every invoice to be anchored to either
-- a client_id (standalone) or a cost_centre_id (the old single-stage job
-- model). migration_012 introduced project_id as the anchor for a new
-- multi-stage invoice (cost_centre_id left null, stage detail living in
-- invoice_claims instead) - which that old constraint didn't know about,
-- so it rejected the row outright.
--
-- Replaces it with the same rule, just also accepting project_id as a
-- valid "this is a job-linked claim" anchor alongside cost_centre_id.

alter table invoices drop constraint if exists invoices_client_or_stage_check;

alter table invoices add constraint invoices_client_or_stage_check
  check (
    (client_id is not null and cost_centre_id is null and project_id is null)
    or (client_id is null and (cost_centre_id is not null or project_id is not null))
  );
