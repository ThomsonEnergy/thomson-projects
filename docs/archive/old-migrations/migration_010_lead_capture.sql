-- Migration 010 — Lead capture from the marketing site
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The marketing site (separate codebase, same Supabase project) inserts
-- rows here directly with the anon key. Anonymous interest signals
-- (package/brand/calculator clicks, no contact info) just sit here for
-- analytics. Anything with an email or phone attached automatically gets
-- a card on the Lead column of the pipeline board — no manual step.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  source text not null,              -- 'package', 'brand', 'calculator', 'enquiry_modal'
  name text,
  phone text,
  email text,
  address_line text,
  suburb text,
  state text,
  postcode text,
  address_formatted text,
  lat numeric,
  lng numeric,
  status text default 'new',
  details jsonb
);

alter table leads enable row level security;

drop policy if exists "Allow public insert only" on leads;
create policy "Allow public insert only"
on leads
for insert
to anon
with check (true);

-- Staff need to actually see these — the marketing site's own spec only
-- covers the public insert side. Scoped to the same pricing roles as other
-- quoting-adjacent data, consistent with how Leads/Sales/Quotes work
-- elsewhere in the app.
drop policy if exists "Pricing roles can view leads" on leads;
create policy "Pricing roles can view leads"
on leads for select
using (is_pricing_role());

drop policy if exists "Pricing roles can update leads" on leads;
create policy "Pricing roles can update leads"
on leads for update
using (is_pricing_role());

-- 2. Link projects back to the lead that created them --------------------

alter table projects
  add column if not exists lead_id uuid references leads(id);

alter table projects
  add column if not exists client_phone text;

-- 3. Auto-create a pipeline card for contactable leads --------------------

create or replace function create_project_from_lead()
returns trigger
language plpgsql
security definer
as $$
declare
  summary text;
begin
  -- Only leads we can actually follow up on get a pipeline card.
  if new.email is null and new.phone is null then
    return new;
  end if;

  summary := 'Web enquiry (' || new.source || ').';
  if new.details is not null then
    summary := summary || E'\n\nDetails captured on the website:\n' || new.details::text;
  end if;

  insert into projects (
    name, client_name, client_email, client_phone, client_address,
    sow_text, pipeline_stage, status, proposal_template, lead_id
  ) values (
    coalesce(new.name, 'New web enquiry'),
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

drop trigger if exists on_lead_created on leads;
create trigger on_lead_created
  after insert on leads
  for each row execute function create_project_from_lead();

-- 4. Storage bucket for lead-submitted files (switchboard photos, bills) ---
-- Private — these can contain someone's home address and utility details,
-- no reason for them to be publicly reachable by URL. Anonymous visitors
-- can upload but never list or read; only pricing roles can view them.

insert into storage.buckets (id, name, public)
values ('lead-uploads', 'lead-uploads', false)
on conflict (id) do nothing;

drop policy if exists "Public can upload lead files" on storage.objects;
create policy "Public can upload lead files"
on storage.objects for insert
to anon
with check (bucket_id = 'lead-uploads');

drop policy if exists "Pricing roles can view lead files" on storage.objects;
create policy "Pricing roles can view lead files"
on storage.objects for select
using (bucket_id = 'lead-uploads' and is_pricing_role());
