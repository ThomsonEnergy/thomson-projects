-- Migration 075 — Mandatory break capture at clock-out
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Clocking out now asks whether the mandatory 30-minute break was taken
-- (and when), or why not if it wasn't - recorded against whichever
-- time_entries row the clock-out actually closes.

alter table time_entries add column if not exists break_taken boolean;
alter table time_entries add column if not exists break_start timestamptz;
alter table time_entries add column if not exists break_minutes integer;
alter table time_entries add column if not exists break_skip_reason text;
