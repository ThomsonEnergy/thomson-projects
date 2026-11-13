-- Migration 105 — Allow 'site_inspection' as a schedule_assignments block_type
--
-- Missed updating this constraint when migration_104 added site
-- inspections - schedule_assignments_block_type_check (migration 028)
-- only allowed 'job', 'site_visit', 'training', 'office', 'other',
-- so scheduling an inspection failed at the database level.

alter table schedule_assignments drop constraint if exists schedule_assignments_block_type_check;
alter table schedule_assignments add constraint schedule_assignments_block_type_check
  check (block_type in ('job', 'site_visit', 'site_inspection', 'training', 'office', 'other'));
