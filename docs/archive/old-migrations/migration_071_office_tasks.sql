-- Migration 071 — Tasks not tied to a job (office/general)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Lets a task be created without a job attached (e.g. "take the bins
-- out", "mow the lawn") - shown as "Office / General" wherever a task's
-- job would normally show.

alter table job_tasks alter column project_id drop not null;
