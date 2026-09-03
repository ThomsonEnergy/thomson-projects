-- Migration 076 — Re-issuable onboarding
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Lets an admin send an already-onboarded employee back through
-- onboarding (a pay rise needing a re-signed contract, updated details,
-- or anything else) without losing the historical record of what they
-- signed the first time. onboarding_cycle_started_at marks when the
-- CURRENT pass began - a document only counts as signed for this pass
-- if signed at or after that timestamp, so old signatures stay in the
-- table (visible in "documents I've signed") instead of being deleted.

alter table profiles add column if not exists onboarding_reissue_reason text
  check (onboarding_reissue_reason in ('pay_rise', 'details_update', 'other'));
alter table profiles add column if not exists onboarding_reissue_note text;
alter table profiles add column if not exists onboarding_cycle_started_at timestamptz;
