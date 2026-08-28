-- Migration 026 — Time-of-day on schedule assignments
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Assignments were previously whole-day only. The week grid view needs
-- an actual start/end time to position and size each block. Existing
-- assignments default to a sensible 7am-3:30pm block rather than being
-- left null, so they still render sensibly in the new view.

alter table schedule_assignments add column if not exists start_time time not null default '07:00:00';
alter table schedule_assignments add column if not exists end_time time not null default '15:30:00';
