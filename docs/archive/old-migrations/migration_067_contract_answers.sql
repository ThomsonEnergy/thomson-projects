-- Migration 067 — Contract answers + probationary period toggle
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The contract generator now resolves every remaining [bracket] in the
-- template - either from a profile field, or from a per-contract answer
-- (letter date, position, hours/days worked, additional hourly rate,
-- travel allowance, salary breakdown) collected in the admin's contract
-- form rather than left as raw text for manual editing. Also makes the
-- Probationary Period clause (2.2-2.3) an explicit on/off toggle instead
-- of always-included.

alter table profiles add column if not exists has_probationary_period boolean not null default true;

alter table employee_contracts add column if not exists answers jsonb not null default '{}';
