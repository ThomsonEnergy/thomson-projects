-- Migration 011 — Client base + contacts + lead-to-client linking
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Clients ---------------------------------------------------------------

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  address text,
  payment_terms text not null default 'cod',
  notes text,
  created_at timestamptz not null default now()
);

alter table clients
  drop constraint if exists clients_payment_terms_check;
alter table clients
  add constraint clients_payment_terms_check
  check (payment_terms in ('cod', 'net_7', 'net_14', 'net_30'));

alter table clients enable row level security;
drop policy if exists "Pricing roles manage clients" on clients;
create policy "Pricing roles manage clients" on clients
  for all using (is_pricing_role()) with check (is_pricing_role());

-- 2. Client contacts ---------------------------------------------------------
-- Multiple contacts per client, each tagged by role. A client can have more
-- than one of the same type (e.g. two site contacts across different jobs).

create table if not exists client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_type text not null,
  name text,
  phone text,
  email text,
  sort_order int not null default 0
);

alter table client_contacts
  drop constraint if exists client_contacts_type_check;
alter table client_contacts
  add constraint client_contacts_type_check
  check (contact_type in ('accounts', 'job', 'site', 'sales', 'project_manager'));

alter table client_contacts enable row level security;
drop policy if exists "Pricing roles manage client contacts" on client_contacts;
create policy "Pricing roles manage client contacts" on client_contacts
  for all using (is_pricing_role()) with check (is_pricing_role());

-- 3. Link projects to a client ---------------------------------------------
-- The project keeps its own client_name/email/phone/address fields as a
-- per-job snapshot (a client's billing address might update later without
-- rewriting history on old quotes) — client_id is what ties them together
-- and lets the client picker auto-fill those fields.

alter table projects
  add column if not exists client_id uuid references clients(id);

-- 4. Update the lead-to-pipeline trigger to find-or-create a client --------

create or replace function create_project_from_lead()
returns trigger
language plpgsql
security definer
as $$
declare
  summary text;
  v_client_id uuid;
begin
  if new.email is null and new.phone is null then
    return new;
  end if;

  -- Find an existing client by email or phone before creating a new one,
  -- so a repeat enquiry from the same person doesn't duplicate them.
  select id into v_client_id from clients
  where (new.email is not null and email = new.email)
     or (new.phone is not null and phone = new.phone)
  limit 1;

  if v_client_id is null then
    insert into clients (name, email, phone, address)
    values (coalesce(new.name, 'New web enquiry'), new.email, new.phone, coalesce(new.address_formatted, new.address_line))
    returning id into v_client_id;
  end if;

  summary := 'Web enquiry (' || new.source || ').';
  if new.details is not null then
    summary := summary || E'\n\nDetails captured on the website:\n' || new.details::text;
  end if;

  insert into projects (
    name, client_id, client_name, client_email, client_phone, client_address,
    sow_text, pipeline_stage, status, proposal_template, lead_id
  ) values (
    coalesce(new.name, 'New web enquiry'),
    v_client_id,
    new.name,
    new.email,
    new.phone,
    coalesce(new.address_formatted, new.address_line),
    summary,
    'lead',
    'draft',
    'new_build',
    new.id
  );

  update leads set status = 'in_pipeline' where id = new.id;

  return new;
end;
$$;
