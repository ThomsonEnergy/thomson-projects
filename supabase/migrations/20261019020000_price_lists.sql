-- Emailed price lists keep material cost prices accurate (backlog item 8, spec A11b).
--
-- price-list-intake.js finds price lists emailed to sales@ or invoice@ (invoice@ lands in
-- sales@), reads every line into supplier_price_items (the supplier's full list), then
-- compares it with our materials through material_supplier_links (which material is which
-- supplier part, learned when a person confirms a match). Small price moves on a known part
-- are applied automatically; big moves, first-time matches and possible replacements wait in
-- price_changes for a person. Every change keeps the old price so it can be undone.
-- Rows are written by the server (service role); people read them and act through
-- price-list-inbox.js. Admin, Finance and Sales only.

create table if not exists public.price_list_imports (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails(id) on delete set null,
  gmail_message_id text not null,
  attachment_part_id text not null,
  file_name text,
  mime_type text,
  file_path text,
  email_from text,
  email_subject text,
  received_at timestamptz,
  status text not null default 'pending',
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name_read text,
  first_for_supplier boolean not null default false,
  pages_total integer,
  pages_done integer not null default 0,
  allow_large boolean not null default false,
  items jsonb not null default '[]'::jsonb,
  read_meta jsonb,
  item_count integer not null default 0,
  auto_applied integer not null default 0,
  waiting integer not null default 0,
  summary text,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  constraint price_list_imports_status_check check (status in ('pending', 'processing', 'to_check', 'applied', 'too_large', 'not_a_price_list', 'failed')),
  constraint price_list_imports_attachment_key unique (gmail_message_id, attachment_part_id)
);

create index if not exists price_list_imports_email_id_idx on public.price_list_imports (email_id);
create index if not exists price_list_imports_supplier_id_idx on public.price_list_imports (supplier_id);
create index if not exists price_list_imports_resolved_by_idx on public.price_list_imports (resolved_by);
create index if not exists price_list_imports_status_idx on public.price_list_imports (status, created_at desc);

create table if not exists public.supplier_price_items (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  item_key text not null,
  part_number text,
  description text not null,
  unit_cost numeric,
  previous_cost numeric,
  last_import_id uuid references public.price_list_imports(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint supplier_price_items_key unique (supplier_id, item_key)
);

create index if not exists supplier_price_items_last_import_id_idx on public.supplier_price_items (last_import_id);

create table if not exists public.material_supplier_links (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  item_key text not null,
  part_number text,
  supplier_description text,
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_supplier_links_key unique (material_id, supplier_id)
);

create index if not exists material_supplier_links_supplier_id_idx on public.material_supplier_links (supplier_id, item_key);
create index if not exists material_supplier_links_confirmed_by_idx on public.material_supplier_links (confirmed_by);

create table if not exists public.price_changes (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references public.price_list_imports(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_price_item_id uuid references public.supplier_price_items(id) on delete set null,
  kind text not null,
  old_cost numeric,
  new_cost numeric,
  change_pct numeric,
  old_name text,
  new_name text,
  old_item_key text,
  reason text,
  status text not null default 'waiting',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  constraint price_changes_kind_check check (kind in ('price', 'match', 'superseded')),
  constraint price_changes_status_check check (status in ('waiting', 'applied', 'skipped', 'undone'))
);

create index if not exists price_changes_import_id_idx on public.price_changes (import_id);
create index if not exists price_changes_material_id_idx on public.price_changes (material_id);
create index if not exists price_changes_supplier_id_idx on public.price_changes (supplier_id);
create index if not exists price_changes_supplier_price_item_id_idx on public.price_changes (supplier_price_item_id);
create index if not exists price_changes_resolved_by_idx on public.price_changes (resolved_by);
create index if not exists price_changes_status_idx on public.price_changes (status, created_at desc);

alter table public.price_list_imports enable row level security;
alter table public.supplier_price_items enable row level security;
alter table public.material_supplier_links enable row level security;
alter table public.price_changes enable row level security;

drop policy if exists "Pricing roles read price list imports" on public.price_list_imports;
create policy "Pricing roles read price list imports" on public.price_list_imports for select to authenticated
  using ((select is_pricing_role()));
drop policy if exists "Pricing roles read supplier price items" on public.supplier_price_items;
create policy "Pricing roles read supplier price items" on public.supplier_price_items for select to authenticated
  using ((select is_pricing_role()));
drop policy if exists "Pricing roles read material supplier links" on public.material_supplier_links;
create policy "Pricing roles read material supplier links" on public.material_supplier_links for select to authenticated
  using ((select is_pricing_role()));
drop policy if exists "Pricing roles read price changes" on public.price_changes;
create policy "Pricing roles read price changes" on public.price_changes for select to authenticated
  using ((select is_pricing_role()));

grant select on public.price_list_imports, public.supplier_price_items, public.material_supplier_links, public.price_changes to authenticated;
grant select, insert, update, delete on public.price_list_imports, public.supplier_price_items, public.material_supplier_links, public.price_changes to service_role;
