-- Run this whole file once in Supabase: Dashboard > SQL Editor > New query > paste > Run

create extension if not exists pgcrypto;

-- Single row of company-wide defaults: your standard terms and conditions,
-- and a reusable library of past-job photos for the proposal cover page.
create table company_settings (
  id int primary key default 1 constraint singleton check (id = 1),
  company_name text not null default '',
  abn text not null default '',
  address text not null default '',
  phone text not null default '',
  website text not null default '',
  licenses text not null default '', -- free text, e.g. "QLD ECL 1508141 | NSW ECL 490514C"
  logo_url text not null default '',
  tagline text not null default '', -- e.g. "Renewable Energy Specialists"
  default_terms text not null default '',
  portfolio_photos jsonb not null default '[]' -- [{ "url": "...", "caption": "..." }, ...]
);
insert into company_settings (id) values (1) on conflict (id) do nothing;

alter table company_settings enable row level security;
create policy "staff full access on company_settings"
  on company_settings for all to authenticated using (true) with check (true);
create policy "public can read company_settings"
  on company_settings for select to anon using (true);

-- One row per big project (the "quote" that gets split into stages)
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_name text not null,
  client_email text,
  client_address text,
  status text not null default 'draft', -- draft, sent, accepted, in_progress, complete
  quote_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  notes text,
  terms_text text not null default '',
  sow_text text not null default '', -- full scope of works document, pasted in
  proposal_subtitle text not null default '', -- e.g. "Grid-Connected Solar Photovoltaic System"
  cover_photos jsonb not null default '[]',    -- past-job photos shown on the title page
  reference_photos jsonb not null default '[]', -- "what it will look like" photos for this job
  deposit_percent numeric(5,2) not null default 10,
  pylon_link text not null default '',       -- link to the interactive Pylon proposal/design
  pylon_project_id text not null default '', -- Pylon project id, used for the optional data pull
  pylon_data jsonb not null default '{}',    -- last-pulled Pylon system data, if you use that feature
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  accepted_at timestamptz
);

-- One row per stage / cost centre (Site Power, Rough In, Fit Off, Finishing...)
-- Each of these becomes its own ServiceM8 Job once the quote is accepted.
create table cost_centres (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0,
  estimated_labour_cost numeric(12,2) not null default 0,
  estimated_material_cost numeric(12,2) not null default 0,
  markup_percent numeric(6,2) not null default 45,
  quoted_amount numeric(12,2) not null default 0, -- sale price, = (labour+material) * (1 + markup/100)
  servicem8_job_uuid text,
  servicem8_job_status text not null default 'not_created', -- not_created, created, in_progress, complete, invoiced
  -- latest known figures pulled back from ServiceM8, updated by the sync function
  labour_cost numeric(12,2) not null default 0,
  material_cost numeric(12,2) not null default 0,
  invoiced_amount numeric(12,2) not null default 0,
  last_synced_at timestamptz
);

create index on cost_centres (project_id);

-- Line items within a stage, e.g. "182 x solar panels" or "Electrician - 2 days".
-- Each stage's labour/material totals and sale price are rolled up from these.
create table cost_centre_line_items (
  id uuid primary key default gen_random_uuid(),
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  description text not null,
  item_type text not null check (item_type in ('labour', 'material')),
  quantity numeric(12,2) not null default 1,
  unit_cost numeric(12,2) not null default 0,
  sort_order int not null default 0
);

create index on cost_centre_line_items (cost_centre_id);

alter table cost_centre_line_items enable row level security;
create policy "staff full access on cost_centre_line_items"
  on cost_centre_line_items for all
  to authenticated
  using (true)
  with check (true);

-- Groups of photos within a stage, each with its own caption, e.g.
-- "Existing switchboard" with 3 photos, "Proposed panel layout" with 2 photos.
create table cost_centre_photo_groups (
  id uuid primary key default gen_random_uuid(),
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  description text not null default '',
  photos jsonb not null default '[]', -- [{ "url": "..." }, ...]
  sort_order int not null default 0
);

create index on cost_centre_photo_groups (cost_centre_id);

alter table cost_centre_photo_groups enable row level security;
create policy "staff full access on cost_centre_photo_groups"
  on cost_centre_photo_groups for all
  to authenticated
  using (true)
  with check (true);

-- Purchase orders and supplier invoices, tracked at the project level (optionally
-- tagged to a specific stage). Kept separate from the actual labour/material costs
-- synced from ServiceM8, so the two are never double-counted.
create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  cost_centre_id uuid references cost_centres(id) on delete set null,
  supplier_name text not null,
  po_number text not null default '',
  description text not null default '',
  amount numeric(12,2) not null default 0,
  status text not null default 'ordered' check (status in ('ordered', 'received', 'invoiced', 'paid')),
  file_path text, -- path within the private project-documents bucket, not a public URL
  file_name text,
  order_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index on purchase_orders (project_id);

alter table purchase_orders enable row level security;
create policy "staff full access on purchase_orders"
  on purchase_orders for all
  to authenticated
  using (true)
  with check (true);

-- Row Level Security: your logged in staff can see/edit everything.
alter table projects enable row level security;
alter table cost_centres enable row level security;

create policy "staff full access on projects"
  on projects for all
  to authenticated
  using (true)
  with check (true);

create policy "staff full access on cost_centres"
  on cost_centres for all
  to authenticated
  using (true)
  with check (true);

-- Public quote page: clients don't log in. They only get in via a secret
-- link (the quote_token), handled through this function rather than opening
-- the tables directly to the public.
create or replace function get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
    'cost_centres', (
      select coalesce(json_agg(
        json_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'photo_groups', (
            select coalesce(json_agg(
              json_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::json)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c where c.project_id = p.id
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$$;

grant execute on function get_quote_by_token(text) to anon, authenticated;

-- Lets the public quote page mark a quote as accepted, again only via the token.
create or replace function accept_quote(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update projects
  set status = 'accepted', accepted_at = now()
  where quote_token = p_token and status in ('draft', 'sent');
end;
$$;

grant execute on function accept_quote(text) to anon, authenticated;

-- Storage bucket for proposal photos (cover page + "what it will look like").
-- Public read (so the client-facing quote page can display them without logging in),
-- staff-only write.
insert into storage.buckets (id, name, public)
values ('proposal-photos', 'proposal-photos', true)
on conflict (id) do nothing;

create policy "public can view proposal photos"
  on storage.objects for select
  to public
  using (bucket_id = 'proposal-photos');

create policy "staff can upload proposal photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'proposal-photos');

create policy "staff can delete proposal photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'proposal-photos');

-- Private bucket for purchase orders and supplier invoices. Unlike proposal
-- photos, these are financial documents, so there is no public read policy;
-- only logged in staff can view or upload them, via signed URLs.
insert into storage.buckets (id, name, public)
values ('project-documents', 'project-documents', false)
on conflict (id) do nothing;

create policy "staff can view project documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'project-documents');

create policy "staff can upload project documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'project-documents');

create policy "staff can delete project documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'project-documents');
