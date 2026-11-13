-- Migration 147 - Staff profile page: written warnings, incident reports
-- (SafeWork NSW WHS Form 10), KPIs, and per-person documents and photos
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Everything here is HR record-keeping, so every table and the storage
-- bucket are admin/finance only (is_finance_role() from migration_083).
-- The employee themself does NOT see these through the app - a warning is
-- handed over printed (or as a PDF) and signed on paper or in person, and
-- the signed copy is uploaded back against the warning.

-- 1. Written warnings ------------------------------------------------------

create table if not exists staff_warnings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  warning_level text not null default 'first',
  category text not null default 'conduct',
  issued_date date not null default current_date,
  incident_date date,
  meeting_date date,
  subject text not null default '',
  details text not null default '',          -- what happened / the concern, factually
  policy_breached text,                      -- e.g. Code of Conduct clause, WHS procedure
  previous_discussions text,                 -- earlier verbal/written warnings or chats
  employee_response text,                    -- the employee's side, recorded at the meeting
  expected_improvement text,                 -- what has to change
  support_offered text,                      -- training, supervision, EAP etc.
  review_date date,
  consequences text,                         -- what happens if it isn't corrected
  support_person text,                       -- who sat in with the employee, if anyone
  issued_by uuid references profiles(id) on delete set null,
  issued_by_name text,
  issued_by_position text,
  status text not null default 'draft',
  acknowledged_at date,                      -- date the employee signed the hard copy
  refused_to_sign boolean not null default false,
  signed_file_path text,                     -- scan/PDF of the signed copy (staff-files bucket)
  signed_file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table staff_warnings drop constraint if exists staff_warnings_level_check;
alter table staff_warnings add constraint staff_warnings_level_check
  check (warning_level in ('first', 'second', 'final'));
alter table staff_warnings drop constraint if exists staff_warnings_category_check;
alter table staff_warnings add constraint staff_warnings_category_check
  check (category in ('conduct', 'performance', 'safety', 'attendance', 'policy', 'other'));
alter table staff_warnings drop constraint if exists staff_warnings_status_check;
alter table staff_warnings add constraint staff_warnings_status_check
  check (status in ('draft', 'issued', 'acknowledged', 'withdrawn'));
create index if not exists staff_warnings_profile_idx on staff_warnings (profile_id, issued_date desc);

-- 2. Incident reports (WHS Form 10) ------------------------------------------
-- profile_id is the staff member it's filed against; injured_name etc. are
-- copied in (and editable) because the injured person on the form may be a
-- visitor or subcontractor rather than the staff member themself.

create table if not exists incident_reports (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  incident_date date not null default current_date,
  incident_time time,
  nature text not null default 'near_miss',
  injured_name text,
  injured_address text,
  injured_occupation text,
  injured_dob date,
  injured_phone text,
  injured_employer text,
  activity text,
  site_location text,
  injury_nature text,
  body_locations text[] not null default '{}',
  body_location_notes text,
  treatment_on_site text,
  treating_person text,
  referral boolean,
  doctor_or_hospital text,
  medical_cert_received boolean,
  injury_management boolean,
  rtw_coordinator_notified boolean,
  rtw_coordinator_name text,
  witnesses jsonb not null default '[]',      -- [{ name, contact }]
  property_damage text,
  report_received_by text,
  report_received_phone text,
  description text,
  immediate_actions text,
  reported_principal_contractor boolean,
  reported_principal_contractor_details text,
  reported_safework boolean,
  reported_safework_details text,
  reported_insurer boolean,
  reported_insurer_details text,
  corrective_actions text,                    -- follow-up to stop it happening again
  completed_by_name text,
  completed_by_position text,
  completed_date date default current_date,
  completed_signature_data_url text,
  status text not null default 'open',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table incident_reports drop constraint if exists incident_reports_nature_check;
alter table incident_reports add constraint incident_reports_nature_check
  check (nature in ('near_miss', 'first_aid', 'medical_treatment', 'property_damage'));
alter table incident_reports drop constraint if exists incident_reports_status_check;
alter table incident_reports add constraint incident_reports_status_check
  check (status in ('open', 'closed'));
create index if not exists incident_reports_profile_idx on incident_reports (profile_id, incident_date desc);

-- 3. KPIs --------------------------------------------------------------------

create table if not exists staff_kpis (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  measure text,                               -- how it's measured
  target text,
  period_start date,
  period_end date,
  result text,
  rating int check (rating is null or rating between 1 and 5),
  status text not null default 'active' check (status in ('active', 'met', 'not_met', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_kpis_profile_idx on staff_kpis (profile_id);

-- 4. Documents and photos ------------------------------------------------------

create table if not exists staff_files (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null default 'document' check (kind in ('document', 'photo')),
  folder text not null default 'General',
  title text,
  file_path text not null,
  file_name text,
  uploaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists staff_files_profile_idx on staff_files (profile_id, kind);

-- 5. RLS: admin/finance only ---------------------------------------------------

alter table staff_warnings enable row level security;
alter table incident_reports enable row level security;
alter table staff_kpis enable row level security;
alter table staff_files enable row level security;

drop policy if exists "admin/finance manage staff warnings" on staff_warnings;
create policy "admin/finance manage staff warnings" on staff_warnings
  for all to authenticated using (is_finance_role()) with check (is_finance_role());

drop policy if exists "admin/finance manage incident reports" on incident_reports;
create policy "admin/finance manage incident reports" on incident_reports
  for all to authenticated using (is_finance_role()) with check (is_finance_role());

drop policy if exists "admin/finance manage staff kpis" on staff_kpis;
create policy "admin/finance manage staff kpis" on staff_kpis
  for all to authenticated using (is_finance_role()) with check (is_finance_role());

drop policy if exists "admin/finance manage staff files" on staff_files;
create policy "admin/finance manage staff files" on staff_files
  for all to authenticated using (is_finance_role()) with check (is_finance_role());

-- 6. Private storage bucket ----------------------------------------------------
-- Separate from project-documents (readable by all staff) so medical
-- certificates and signed warnings can't be opened by anyone else.

insert into storage.buckets (id, name, public)
values ('staff-files', 'staff-files', false)
on conflict (id) do nothing;

drop policy if exists "admin/finance read staff files" on storage.objects;
create policy "admin/finance read staff files"
  on storage.objects for select to authenticated
  using (bucket_id = 'staff-files' and is_finance_role());

drop policy if exists "admin/finance upload staff files" on storage.objects;
create policy "admin/finance upload staff files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'staff-files' and is_finance_role());

drop policy if exists "admin/finance delete staff files" on storage.objects;
create policy "admin/finance delete staff files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'staff-files' and is_finance_role());
