-- Only needed if you already ran the original schema.sql before the
-- labour/material/markup fields were added. Safe to run even if you haven't,
-- it will just do nothing.

alter table cost_centres add column if not exists estimated_labour_cost numeric(12,2) not null default 0;
alter table cost_centres add column if not exists estimated_material_cost numeric(12,2) not null default 0;
alter table cost_centres add column if not exists markup_percent numeric(6,2) not null default 45;
