-- Migration 103 — Persistent project notes, lead title
--
-- Jasper's feedback on the lead conversion flow: the lead's captured
-- context wasn't showing up anywhere obvious on the resulting quote, and
-- there was nowhere for it to live long-term anyway - sow_text gets
-- rewritten/regenerated as the scope of works evolves, so it's the wrong
-- place for "background context that should stick around". Turns out
-- projects.notes already exists (added directly at some point, not
-- through a tracked migration - not referenced by any current app code)
-- - exactly the single persistent free-text field needed here, separate
-- from sow_text/description, so no new column for it. Distinct from
-- project_field_notes (migration 084), which is a timestamped log of
-- on-site sign-off notes, not a single running note.

-- A short (3-6 word) label for what a lead actually is, generated
-- alongside ai_summary (generate-lead-summary.js) - used for naming the
-- job/quote created from it instead of the generic "{name} - {source}"
-- label, e.g. "Jasper - Switchboard upgrade" instead of "Jasper - Enquiry
-- form".
alter table leads add column ai_title text;
