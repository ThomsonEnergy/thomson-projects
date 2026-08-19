-- Only needed if you already ran schema.sql before this update. Safe to run
-- even if you haven't, it will just do nothing.

alter table company_settings add column if not exists company_name text not null default '';
alter table company_settings add column if not exists abn text not null default '';
alter table company_settings add column if not exists address text not null default '';
alter table company_settings add column if not exists phone text not null default '';
alter table company_settings add column if not exists website text not null default '';
alter table company_settings add column if not exists licenses text not null default '';
alter table company_settings add column if not exists logo_url text not null default '';
alter table company_settings add column if not exists tagline text not null default '';

alter table projects add column if not exists sow_text text not null default '';
alter table projects add column if not exists proposal_subtitle text not null default '';

create table if not exists cost_centre_line_items (
  id uuid primary key default gen_random_uuid(),
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  description text not null,
  item_type text not null check (item_type in ('labour', 'material')),
  quantity numeric(12,2) not null default 1,
  unit_cost numeric(12,2) not null default 0,
  sort_order int not null default 0
);

create index if not exists cost_centre_line_items_cost_centre_id_idx on cost_centre_line_items (cost_centre_id);

alter table cost_centre_line_items enable row level security;
drop policy if exists "staff full access on cost_centre_line_items" on cost_centre_line_items;
create policy "staff full access on cost_centre_line_items"
  on cost_centre_line_items for all to authenticated using (true) with check (true);
