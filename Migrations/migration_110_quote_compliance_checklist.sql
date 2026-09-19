-- Migration 110 - Quote compliance document checklist
--
-- The existing "Check compliance" button on a solar quote only checks
-- things this app already has data for (Pylon linked, deposit set, STC
-- figures, terms present) - it can't tell sales what paperwork to
-- actually go collect from the customer. This adds a second, manual
-- checklist alongside it: a pre-built list of yes/no questions (with
-- conditional photo-upload follow-ups, same pattern as the site
-- inspection checklists) that sales work through with the customer and
-- answer directly on the quote - "documents to gather", not a technical
-- check. Both stay - Jasper confirmed keeping the automatic checks too.
--
-- Reuses inspection_checklist_templates/items rather than a parallel
-- table set, since the shape (yes/no + conditional photo item, template
-- + items) is identical - just adds checklist_type so the Settings
-- editor and this feature can each find their own templates without
-- seeing the other's. Answers get their own table though (rather than
-- reusing site_inspection_answers), since these aren't tied to a
-- site_inspections row - a quote's document checklist isn't scheduled
-- or done on site, it's answered inline by sales whenever, exactly once
-- per quote.

alter table inspection_checklist_templates add column checklist_type text not null default 'site_inspection'
  check (checklist_type in ('site_inspection', 'quote_compliance'));

create table quote_compliance_answers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  item_id uuid not null references inspection_checklist_items(id) on delete cascade,
  answer_yes_no boolean,
  photo_path text,
  answered_by uuid references profiles(id),
  answered_at timestamptz not null default now(),
  unique (project_id, item_id)
);
create index quote_compliance_answers_project_id_idx on quote_compliance_answers(project_id);

-- Sales-only (same pricing-role gate as the rest of the quote editor),
-- unlike site_inspection_answers which is open to any authenticated
-- field staff member doing the physical visit.
alter table quote_compliance_answers enable row level security;
create policy "Pricing roles manage quote compliance answers" on quote_compliance_answers
  for all using (is_pricing_role()) with check (is_pricing_role());

-- One starter template, editable afterwards via Settings > Inspection
-- Checklists (now split Site inspection / Quote compliance). Scoped to
-- solar per Jasper's call - general electrical quotes don't carry the
-- same NETCC/STC paperwork burden.
insert into inspection_checklist_templates (id, name, sort_order, checklist_type) values
  ('a0000000-0000-4000-8000-000000000003', 'Solar Quote - Documents to Gather', 1, 'quote_compliance');

insert into inspection_checklist_items (id, template_id, parent_item_id, show_when_parent_answer, item_type, label, description, required, sort_order) values
  ('b0000000-0000-4000-8000-000000000031', 'a0000000-0000-4000-8000-000000000003', null, null, 'yes_no', 'Does the customer have a recent electricity bill?', 'Needed for the NMI and retailer details.', true, 1),
  ('b0000000-0000-4000-8000-000000000032', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000031', true, 'photo', 'Electricity bill', 'Photo or scan of a recent bill.', true, 2),
  ('b0000000-0000-4000-8000-000000000033', 'a0000000-0000-4000-8000-000000000003', null, null, 'yes_no', 'Is the customer the owner of the property?', 'If not, written consent from the owner is required before installing.', true, 3),
  ('b0000000-0000-4000-8000-000000000034', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000033', false, 'photo', 'Owner consent', 'Written consent from the property owner to install.', true, 4),
  ('b0000000-0000-4000-8000-000000000035', 'a0000000-0000-4000-8000-000000000003', null, null, 'yes_no', 'Is the property on a strata title / owners corporation?', null, true, 5),
  ('b0000000-0000-4000-8000-000000000036', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000035', true, 'photo', 'Strata approval', 'Written approval from the strata/owners corporation for the installation.', true, 6),
  ('b0000000-0000-4000-8000-000000000037', 'a0000000-0000-4000-8000-000000000003', null, null, 'yes_no', 'Do you have photo ID for the customer? (for the STC assignment form)', 'Driver licence, passport, or similar.', true, 7),
  ('b0000000-0000-4000-8000-000000000038', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000037', true, 'photo', 'Photo ID', null, true, 8),
  ('b0000000-0000-4000-8000-000000000039', 'a0000000-0000-4000-8000-000000000003', null, null, 'yes_no', 'Does the property already have solar installed?', null, true, 9),
  ('b0000000-0000-4000-8000-00000000003a', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000039', true, 'photo', 'Existing system documentation', 'Compliance certificate, warranty, or install docs, if the customer has them.', false, 10);
