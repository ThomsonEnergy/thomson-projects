-- Only needed if you already ran schema.sql before this update. Safe to run
-- even if you haven't, it will just do nothing.

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  cost_centre_id uuid references cost_centres(id) on delete set null,
  supplier_name text not null,
  po_number text not null default '',
  description text not null default '',
  amount numeric(12,2) not null default 0,
  status text not null default 'ordered' check (status in ('ordered', 'received', 'invoiced', 'paid')),
  file_path text,
  file_name text,
  order_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists purchase_orders_project_id_idx on purchase_orders (project_id);

alter table purchase_orders enable row level security;
drop policy if exists "staff full access on purchase_orders" on purchase_orders;
create policy "staff full access on purchase_orders"
  on purchase_orders for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('project-documents', 'project-documents', false)
on conflict (id) do nothing;

drop policy if exists "staff can view project documents" on storage.objects;
create policy "staff can view project documents"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-documents');

drop policy if exists "staff can upload project documents" on storage.objects;
create policy "staff can upload project documents"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'project-documents');

drop policy if exists "staff can delete project documents" on storage.objects;
create policy "staff can delete project documents"
  on storage.objects for delete to authenticated
  using (bucket_id = 'project-documents');
