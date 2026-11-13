-- Migration 030 — CCEW (Certificate of Compliance for Electrical Work)
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- CCEW submission itself now happens through the Building and Energy
-- Commission's own website, not through this app - no in-app form is
-- needed for that. What's needed here is simpler: a place to attach the
-- resulting certificate to the job, or record why one isn't required
-- (e.g. the job wasn't electrical work) - shown once a job reaches
-- Client Handover.

alter table projects add column if not exists ccew_file_path text;
alter table projects add column if not exists ccew_not_required_reason text;
