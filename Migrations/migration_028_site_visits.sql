-- Migration 028 — Site visits on the schedule
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- A site visit is scheduled time against a lead/draft quote that hasn't
-- become an approved job yet (no job number assigned) - distinct from
-- actual job work, which only happens once a job exists. Same underlying
-- mechanism as job blocks (a project_id on the assignment), just a
-- different block_type so it can be styled and reasoned about separately.

alter table schedule_assignments drop constraint if exists schedule_assignments_block_type_check;
alter table schedule_assignments add constraint schedule_assignments_block_type_check
  check (block_type in ('job', 'site_visit', 'training', 'office', 'other'));
