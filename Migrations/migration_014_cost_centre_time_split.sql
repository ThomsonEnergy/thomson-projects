-- Migration 014 — Cost centre time splitting
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Lets a time entry optionally be tied to a specific stage (cost centre)
-- within its project, not just the project as a whole. Used by the
-- "Split this entry across cost centres" tool — a finished entry gets
-- replaced by several new entries, each with its own cost_centre_id and a
-- slice of the original duration.

alter table time_entries
  add column if not exists cost_centre_id uuid references cost_centres(id);
