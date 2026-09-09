-- Migration 095: track a failed background text-extraction on a Knowledge
-- Base entry, so the UI can show "couldn't read this" instead of leaving
-- content silently null forever (see extract-knowledge-content-background.js).
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

alter table knowledge_entries add column if not exists extraction_error text;
