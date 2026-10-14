-- Migration 148 - Incidents as a hub (people tagged with roles, evidence,
-- corrective actions, SafeWork and workers comp tracking) and written
-- warnings / counselling letters signed in the app.
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Migration 147 filed an incident against one staff member. A real incident
-- often has several people in it (the person who cut a live cable, and the
-- person who energised the circuit weeks earlier without checking it), so
-- people now live in incident_people with a role each, and any warning that
-- comes out of the incident links back to it.

-- 1. Warnings: letter type, active period, resolution, in-app signatures ------

alter table staff_warnings add column if not exists letter_type text not null default 'warning';
alter table staff_warnings drop constraint if exists staff_warnings_letter_type_check;
alter table staff_warnings add constraint staff_warnings_letter_type_check check (letter_type in ('warning', 'counselling'));
alter table staff_warnings add column if not exists incident_id uuid references incident_reports(id) on delete set null;
alter table staff_warnings add column if not exists active_months int not null default 12;
alter table staff_warnings add column if not exists resolved_at date;
alter table staff_warnings add column if not exists resolved_note text;
alter table staff_warnings add column if not exists resolved_by_name text;
alter table staff_warnings add column if not exists manager_signature_data_url text;
alter table staff_warnings add column if not exists manager_signed_at timestamptz;
alter table staff_warnings add column if not exists employee_signature_data_url text;
alter table staff_warnings add column if not exists employee_signed_name text;
alter table staff_warnings add column if not exists employee_signed_at timestamptz;
alter table staff_warnings add column if not exists employee_signed_how text;   -- 'in_person' or 'in_app'
alter table staff_warnings add column if not exists employee_comments text;
alter table staff_warnings add column if not exists witness_signature_data_url text;
alter table staff_warnings add column if not exists witness_signed_at timestamptz;
alter table staff_warnings add column if not exists sent_to_employee_at timestamptz;
alter table staff_warnings drop constraint if exists staff_warnings_status_check;
alter table staff_warnings add constraint staff_warnings_status_check
  check (status in ('draft', 'issued', 'acknowledged', 'resolved', 'withdrawn'));
create index if not exists staff_warnings_incident_idx on staff_warnings (incident_id);

-- The employee can read their own letters once they've been sent to them
-- (never drafts). They can't update the row directly - signing goes through
-- sign_hr_letter() below so they can only touch their own signature fields.
drop policy if exists "employee reads own sent letters" on staff_warnings;
create policy "employee reads own sent letters" on staff_warnings
  for select to authenticated
  using (profile_id = auth.uid() and sent_to_employee_at is not null and status <> 'draft');

create or replace function send_hr_letter(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare w staff_warnings;
begin
  if not is_finance_role() then raise exception 'Only admin or finance can send letters'; end if;
  select * into w from staff_warnings where id = p_id;
  if w.id is null then raise exception 'Letter not found'; end if;
  if w.status = 'draft' then raise exception 'Sign and issue the letter before sending it'; end if;
  update staff_warnings set sent_to_employee_at = coalesce(sent_to_employee_at, now()) where id = p_id;
  -- Also used to tell them a letter has been marked resolved; the dedupe
  -- key includes the status so that second notice isn't swallowed.
  perform create_notification(
    w.profile_id, 'hr_letter',
    case when w.status = 'resolved' then 'Good news: a matter on your file has been resolved'
         when w.letter_type = 'counselling' then 'A letter from management to read and sign'
         else 'A written warning to read and sign' end,
    case when w.status = 'resolved' then 'Open it to read the resolution letter.'
         else 'Please read it, add any comments, and sign to confirm you have received it.' end,
    '/letter.html?id=' || p_id, auth.uid(), 'hr_letter:' || p_id || ':' || w.status);
end $$;
revoke all on function send_hr_letter(uuid) from public, anon;
grant execute on function send_hr_letter(uuid) to authenticated;

create or replace function sign_hr_letter(p_id uuid, p_signature text, p_name text, p_comments text)
returns void language plpgsql security definer set search_path = public as $$
declare w staff_warnings;
begin
  select * into w from staff_warnings where id = p_id;
  if w.id is null or w.profile_id <> auth.uid() or w.sent_to_employee_at is null then raise exception 'Letter not found'; end if;
  if w.employee_signed_at is not null then raise exception 'You have already signed this letter'; end if;
  if coalesce(p_signature, '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'Add your name and signature'; end if;
  update staff_warnings set
    employee_signature_data_url = p_signature,
    employee_signed_name = trim(p_name),
    employee_signed_at = now(),
    employee_signed_how = 'in_app',
    employee_comments = nullif(trim(coalesce(p_comments, '')), ''),
    acknowledged_at = current_date,
    status = case when status = 'issued' then 'acknowledged' else status end,
    updated_at = now()
  where id = p_id;
  perform create_notification(
    w.issued_by, 'hr_letter_signed',
    coalesce((select full_name from profiles where id = w.profile_id), 'An employee') || ' signed their letter',
    coalesce(nullif(w.subject, ''), 'Written warning') || case when coalesce(trim(p_comments), '') <> '' then ' - they added comments' else '' end,
    '/staff.html?id=' || w.profile_id || '&tab=warnings', auth.uid(), 'hr_letter_signed:' || p_id);
end $$;
revoke all on function sign_hr_letter(uuid, text, text, text) from public, anon;
grant execute on function sign_hr_letter(uuid, text, text, text) to authenticated;

-- 2. Incidents: reference number, investigation, SafeWork, workers comp --------

alter table incident_reports add column if not exists incident_number bigint generated by default as identity;
alter table incident_reports add column if not exists title text;
alter table incident_reports add column if not exists injured_profile_id uuid references profiles(id) on delete set null;
alter table incident_reports add column if not exists root_cause text;
alter table incident_reports add column if not exists investigation_findings text;
alter table incident_reports add column if not exists notifiable boolean;
alter table incident_reports add column if not exists notifiable_categories text[] not null default '{}';
alter table incident_reports add column if not exists safework_notified_at timestamptz;
alter table incident_reports add column if not exists safework_reference text;
alter table incident_reports add column if not exists wc_required boolean;
alter table incident_reports add column if not exists wc_insurer text;
alter table incident_reports add column if not exists wc_policy_number text;
alter table incident_reports add column if not exists wc_insurer_notified_at timestamptz;
alter table incident_reports add column if not exists wc_claim_number text;
alter table incident_reports add column if not exists wc_claim_status text;
alter table incident_reports add column if not exists wc_days_off numeric;
alter table incident_reports add column if not exists wc_return_to_work_date date;
alter table incident_reports add column if not exists wc_notes text;
alter table incident_reports drop constraint if exists incident_reports_nature_check;
alter table incident_reports add constraint incident_reports_nature_check
  check (nature in ('near_miss', 'first_aid', 'medical_treatment', 'lost_time', 'dangerous_incident', 'property_damage'));

-- 3. People in an incident --------------------------------------------------------

create table if not exists incident_people (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incident_reports(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,   -- null for visitors, subbies, the public
  name text not null,
  contact text,
  role text not null default 'involved',
  what_happened text,          -- their part in it
  finding text,                -- what should have happened / contributing factor
  procedure_breached text,
  at_fault boolean not null default false,
  statement text,              -- their own account, in their words
  statement_signature_data_url text,
  statement_signed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table incident_people drop constraint if exists incident_people_role_check;
alter table incident_people add constraint incident_people_role_check
  check (role in ('injured', 'involved', 'contributed', 'witness', 'reported', 'supervisor', 'other'));
create index if not exists incident_people_incident_idx on incident_people (incident_id);
create index if not exists incident_people_profile_idx on incident_people (profile_id);

-- 4. Evidence (photos, documents, medical certificates) ---------------------------

create table if not exists incident_files (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incident_reports(id) on delete cascade,
  kind text not null default 'document' check (kind in ('document', 'photo')),
  category text not null default 'General',
  title text,
  file_path text not null,     -- staff-files bucket, incidents/<incident id>/...
  file_name text,
  uploaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists incident_files_incident_idx on incident_files (incident_id);

-- 5. Corrective actions --------------------------------------------------------------

create table if not exists incident_actions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incident_reports(id) on delete cascade,
  description text not null,
  assigned_to uuid references profiles(id) on delete set null,
  due_date date,
  done_at date,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists incident_actions_incident_idx on incident_actions (incident_id);

-- 6. RLS: admin/finance only ------------------------------------------------------------

alter table incident_people enable row level security;
alter table incident_files enable row level security;
alter table incident_actions enable row level security;

drop policy if exists "admin/finance manage incident people" on incident_people;
create policy "admin/finance manage incident people" on incident_people
  for all to authenticated using (is_finance_role()) with check (is_finance_role());
drop policy if exists "admin/finance manage incident files" on incident_files;
create policy "admin/finance manage incident files" on incident_files
  for all to authenticated using (is_finance_role()) with check (is_finance_role());
-- Staff can open their own staff profile card: they see their own KPIs
-- (read only). Incidents, HR files and photos stay admin/finance only.
drop policy if exists "employee reads own kpis" on staff_kpis;
create policy "employee reads own kpis" on staff_kpis
  for select to authenticated using (profile_id = auth.uid());

drop policy if exists "admin/finance manage incident actions" on incident_actions;
create policy "admin/finance manage incident actions" on incident_actions
  for all to authenticated using (is_finance_role()) with check (is_finance_role());
