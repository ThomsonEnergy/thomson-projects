-- Migration 104 — Site inspections
--
-- "Needs site visit" can be ticked on a lead, quote, or job (projects
-- covers both quotes and jobs already - job_number is what tells them
-- apart). Scheduling one draws from a checklist template (different
-- templates per job type - e.g. Solar & Battery vs General Electrical,
-- modeled on a Runbase reference reviewed for the photo-requirements
-- pattern, not a straight port - see PROJECT_SPEC.md Part K) and creates
-- a real schedule_assignments block so it shows up on the existing
-- Schedule page like any other booking. The assigned field staff fill it
-- out on site via a dedicated page (site-inspection.html).
--
-- No scheduled-date/staff columns on site_inspections itself - that
-- lives only on the linked schedule_assignments row, so rescheduling
-- (drag on the Schedule page, or editing the block) can never drift out
-- of sync with a duplicated copy here.

alter table leads add column needs_site_visit boolean not null default false;
alter table projects add column needs_site_visit boolean not null default false;

create table inspection_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order int not null default 0,
  active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- item_type 'photo' - a required (or optional) photo upload.
-- item_type 'yes_no' - a Yes/No question; other items can be conditioned
-- on its answer via parent_item_id + show_when_parent_answer, exactly
-- the "Does the property have a sub-board?" -> reveals "Sub Board photo"
-- pattern from the reference. parent_item_id null = always shown.
create table inspection_checklist_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references inspection_checklist_templates(id) on delete cascade,
  parent_item_id uuid references inspection_checklist_items(id) on delete cascade,
  show_when_parent_answer boolean,
  item_type text not null check (item_type in ('photo', 'yes_no')),
  label text not null,
  description text,
  required boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index inspection_checklist_items_template_id_idx on inspection_checklist_items(template_id);
create index inspection_checklist_items_parent_item_id_idx on inspection_checklist_items(parent_item_id);

create table site_inspections (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  template_id uuid not null references inspection_checklist_templates(id),
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed')),
  completed_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint site_inspections_lead_or_project check (
    (lead_id is not null and project_id is null) or (lead_id is null and project_id is not null)
  )
);
create index site_inspections_lead_id_idx on site_inspections(lead_id);
create index site_inspections_project_id_idx on site_inspections(project_id);

create table site_inspection_answers (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references site_inspections(id) on delete cascade,
  item_id uuid not null references inspection_checklist_items(id) on delete cascade,
  answer_yes_no boolean,
  photo_path text,
  answered_by uuid references profiles(id),
  answered_at timestamptz not null default now(),
  unique (inspection_id, item_id)
);

-- Links a scheduled inspection to a real block on the Schedule page -
-- block_type 'site_inspection' alongside the existing 'job'/'site_visit'/
-- 'training'/'office'/'other' values schedule.html already renders.
alter table schedule_assignments add column site_inspection_id uuid references site_inspections(id) on delete cascade;

alter table inspection_checklist_templates enable row level security;
create policy "Everyone can view checklist templates" on inspection_checklist_templates for select using (auth.uid() is not null);
create policy "Pricing roles manage checklist templates" on inspection_checklist_templates for insert with check (is_pricing_role());
create policy "Pricing roles update checklist templates" on inspection_checklist_templates for update using (is_pricing_role());
create policy "Pricing roles delete checklist templates" on inspection_checklist_templates for delete using (is_pricing_role());

alter table inspection_checklist_items enable row level security;
create policy "Everyone can view checklist items" on inspection_checklist_items for select using (auth.uid() is not null);
create policy "Pricing roles manage checklist items" on inspection_checklist_items for insert with check (is_pricing_role());
create policy "Pricing roles update checklist items" on inspection_checklist_items for update using (is_pricing_role());
create policy "Pricing roles delete checklist items" on inspection_checklist_items for delete using (is_pricing_role());

-- Scheduling one (insert) is a pricing-role action, same as scheduling
-- any job - but any authenticated user can update status/complete it,
-- since the field staff actually doing the inspection may not be a
-- pricing role.
alter table site_inspections enable row level security;
create policy "Everyone can view site inspections" on site_inspections for select using (auth.uid() is not null);
create policy "Pricing roles create site inspections" on site_inspections for insert with check (is_pricing_role());
create policy "Authenticated can update site inspections" on site_inspections for update using (auth.uid() is not null);
create policy "Pricing roles delete site inspections" on site_inspections for delete using (is_pricing_role());

-- Open to any authenticated user, same pattern as project_field_notes/
-- project_photos (migration 084) - whoever's doing the inspection needs
-- to answer it regardless of role.
alter table site_inspection_answers enable row level security;
create policy "staff full access on site_inspection_answers" on site_inspection_answers for all to authenticated using (true) with check (true);

-- Two starter templates, editable afterwards via the checklist template
-- editor (Settings). Solar & Battery follows the photo-requirements/
-- conditional-question pattern from the Runbase reference reviewed
-- earlier (see PROJECT_SPEC.md Part K) - approximated, not a pixel-exact
-- port, per that note's own instruction. General Electrical is a
-- simpler original list for non-solar callouts/repairs.

insert into inspection_checklist_templates (id, name, sort_order) values
  ('a0000000-0000-4000-8000-000000000001', 'Solar & Battery Install', 1),
  ('a0000000-0000-4000-8000-000000000002', 'General Electrical', 2);

insert into inspection_checklist_items (id, template_id, parent_item_id, show_when_parent_answer, item_type, label, description, required, sort_order) values
  -- Solar & Battery
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Meter Box', 'Full shot including the label and ID physical location on the property.', true, 1),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Meter & Point ID', 'Photo of the Meter ID and the Point ID.', true, 2),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Switchboard', 'Clear photo of the main switchboard with all breakers visible.', true, 3),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the property have a sub-distribution board?', null, true, 4),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000004', true, 'photo', 'Sub Board', 'Clear photo of the sub-distribution board.', true, 5),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the client need service fuses?', null, true, 6),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the client need a meter upgrade?', null, true, 7),
  ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Roof Profile', 'Upload roof pitch(es) and/or overall roof photo(s).', true, 8),
  ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Property Front', 'Clear photo of the front of the property.', true, 9),
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Is the system being installed on a shed or carport?', null, true, 10),
  ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', true, 'photo', 'Shed/Carport Mounting Structure', 'Photo from below confirming the structure/cross bar is suitable for installation.', true, 11),
  ('b0000000-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the client have an existing solar system?', null, true, 12),
  ('b0000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000c', true, 'photo', 'Existing Solar System', 'Photos of the current system - clear, serviceable photos of each inverter, panel, and battery. Model numbers must be visible.', true, 13),
  ('b0000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Battery Location / Access', 'Photo of the proposed battery installation location and access area.', true, 14),
  ('b0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Is the battery and inverter an all-in-one unit?', null, true, 15),
  ('b0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000f', false, 'photo', 'New Inverter Location', 'Photo of the proposed location where the new inverter will be installed.', true, 16),
  ('b0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the client need a gateway? (signal/relay for the battery)', null, true, 17),
  ('b0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000011', true, 'photo', 'Gateway Location', 'Photo of the proposed gateway location.', true, 18),
  ('b0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', null, null, 'photo', 'Power Bill & NMI', 'Clear photo of the meter''s NMI, or the bill confirming the NMI number.', true, 19),
  ('b0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', null, null, 'yes_no', 'Does the client have mobile phone reception from their Wi-Fi at the spot where the inverter will be installed?', null, true, 20),

  -- General Electrical
  ('b0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000002', null, null, 'photo', 'Property Front', 'Clear photo of the front of the property.', true, 1),
  ('b0000000-0000-4000-8000-000000000022', 'a0000000-0000-4000-8000-000000000002', null, null, 'photo', 'Switchboard', 'Clear photo of the main switchboard with all breakers visible.', true, 2),
  ('b0000000-0000-4000-8000-000000000023', 'a0000000-0000-4000-8000-000000000002', null, null, 'photo', 'Meter Box', 'Full shot including the label and meter ID.', true, 3),
  ('b0000000-0000-4000-8000-000000000024', 'a0000000-0000-4000-8000-000000000002', null, null, 'yes_no', 'Does the property have a sub-distribution board?', null, true, 4),
  ('b0000000-0000-4000-8000-000000000025', 'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000024', true, 'photo', 'Sub Board', 'Clear photo of the sub-distribution board.', true, 5),
  ('b0000000-0000-4000-8000-000000000026', 'a0000000-0000-4000-8000-000000000002', null, null, 'yes_no', 'Is there existing damage or a known fault?', null, true, 6),
  ('b0000000-0000-4000-8000-000000000027', 'a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000026', true, 'photo', 'Fault / Damage', 'Clear photo(s) of the fault or damage area.', true, 7),
  ('b0000000-0000-4000-8000-000000000028', 'a0000000-0000-4000-8000-000000000002', null, null, 'yes_no', 'Is there safe, clear access to the work area?', null, true, 8);
