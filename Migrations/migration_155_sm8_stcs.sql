-- Migration 155 - ServiceM8 STCs, entered by hand
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The ServiceM8 import (migration 153) does not apply a job's STCs itself:
-- the STC rebate lines it found are kept here, and in the job's notes, so
-- staff can enter them the normal way - the job's STCs tab (job_stcs, which
-- the Formbay/STCs page tracks) and the stage's STC credit. The STCs tab
-- reads this to offer each one prefilled.
-- Shape: [{ "type": "pv" | "bstc" | "swh", "count": 160, "price": 35, "total": 5600, "label": "STC Rebate" }]

alter table projects add column if not exists sm8_stcs jsonb;
