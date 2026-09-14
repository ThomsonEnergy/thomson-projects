-- Migration 101 — Warranty jobs
--
-- New feature (approved on the Bugs & Updates board, discussed alongside
-- credit notes): when something needs fixing on a job after it's closed
-- out, open a real, separate warranty job for it - own job number, staff
-- can clock into it and raise POs against it directly, same as any other
-- "+ New job (no quote)" job - but its accrued cost rolls back to reduce
-- the ORIGINAL job's actual profit, net of whatever gets recovered
-- (manufacturer or client billed). It also carries a reference back to
-- the original job's scope of works and documents, so whoever does the
-- warranty work has the context without duplicating any of it.

alter table projects add column warranty_of_project_id uuid references projects(id) on delete set null;
create index projects_warranty_of_project_id_idx on projects(warranty_of_project_id);

-- Set once the warranty job is closed out - which of the three outcomes
-- Jasper described: absorbed entirely (no_bill), claimed back from the
-- manufacturer, or partly billed to the client because not everything
-- logged against it turned out to be genuine warranty work. null until
-- then (still open/in progress).
alter table projects add column warranty_outcome text check (warranty_outcome in ('no_bill', 'manufacturer', 'client'));
alter table projects add column warranty_closed_at timestamptz;

-- Lets an invoice be billed to someone other than the job's own client -
-- specifically for the "bill manufacturer" warranty outcome, where the
-- job's own client is still the property owner but the invoice needs to
-- go to the equipment manufacturer instead. null (the default, and every
-- existing invoice) means "bill the job's own client", exactly today's
-- behaviour - this is purely additive.
alter table invoices add column bill_to_client_id uuid references clients(id) on delete set null;
