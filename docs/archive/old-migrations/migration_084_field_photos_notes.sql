-- Migration 084 — Site photos and field notes/sign-off
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The clock-out "before you go" reminder ("upload site photos", "sort any
-- forms that need signing") was just advisory text - nothing behind it,
-- nowhere to actually put a photo or a note. This gives it somewhere real
-- to go, so it can be done right there in the clock-out/switch-job flow
-- without navigating to the job page.

create table if not exists project_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  staff_id uuid references profiles(id),
  url text not null,
  caption text,
  created_at timestamptz not null default now()
);

alter table project_photos enable row level security;
drop policy if exists "Everyone can view project photos" on project_photos;
create policy "Everyone can view project photos" on project_photos for select using (true);
drop policy if exists "Everyone can add project photos" on project_photos;
create policy "Everyone can add project photos" on project_photos
  for insert with check (auth.uid() is not null);

-- A quick field note, optionally signed (name + drawn signature) - the
-- generic stand-in for "sort any forms that need signing" until specific
-- compliance forms are digitised; covers a site sign-off note today.
create table if not exists project_field_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  staff_id uuid references profiles(id),
  note text not null,
  signed_by_name text,
  signature_data_url text,
  created_at timestamptz not null default now()
);

alter table project_field_notes enable row level security;
drop policy if exists "Everyone can view project field notes" on project_field_notes;
create policy "Everyone can view project field notes" on project_field_notes for select using (true);
drop policy if exists "Everyone can add project field notes" on project_field_notes;
create policy "Everyone can add project field notes" on project_field_notes
  for insert with check (auth.uid() is not null);

insert into storage.buckets (id, name, public)
values ('site-photos', 'site-photos', true)
on conflict (id) do nothing;

drop policy if exists "public can view site photos" on storage.objects;
create policy "public can view site photos"
  on storage.objects for select to public
  using (bucket_id = 'site-photos');

drop policy if exists "staff can upload site photos" on storage.objects;
create policy "staff can upload site photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'site-photos');

drop policy if exists "staff can delete site photos" on storage.objects;
create policy "staff can delete site photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'site-photos');
