-- Item 41 (materials and the Bill tick): a material costed to a job (PO line received to it or a
-- Stock draw) and a clocked shift can be marked not billable from the Invoice actual costs panel,
-- so it is left off the invoice and does not come back on the next one (tick it again to bill it).
-- Default yes, nothing else changes. No RLS change: existing policies cover the column.

alter table public.job_material_usage add column if not exists billable boolean not null default true;
alter table public.time_entries add column if not exists billable boolean not null default true;
