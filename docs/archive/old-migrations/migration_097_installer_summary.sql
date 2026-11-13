-- Migration 097: installer-facing job summary (Cooper's suggestion on the
-- Bugs & Updates board - "Installer job card quote summary"). An AI-
-- generated plain-language inclusions/exclusions summary of the scope of
-- works, so someone on site doesn't have to read the full prose SOW
-- document to know what's actually in scope. Cached on the project row
-- (regenerated on demand, not automatically) rather than an API call on
-- every page load.
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

alter table projects add column if not exists installer_summary text;
alter table projects add column if not exists installer_summary_generated_at timestamptz;
