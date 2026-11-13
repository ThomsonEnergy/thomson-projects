-- Migration 153 - ServiceM8 open-jobs import
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- One-time move of the jobs still open in ServiceM8 into the app as Direct
-- Jobs (Settings > ServiceM8 Import, sm8-import-preview.js / sm8-import-jobs.js).
-- Each imported job keeps ServiceM8's own record id and job number, so:
--   * re-running the import skips anything already brought across (the
--     unique index is the real guard, not just the pre-check in the function)
--   * staff can still find a job by its old ServiceM8 number
-- clients.sm8_company_uuid does the same for clients: once a ServiceM8
-- company has been matched or created, later runs link straight to it.

alter table projects add column if not exists sm8_job_uuid text;
alter table projects add column if not exists sm8_job_number text;
create unique index if not exists projects_sm8_job_uuid_key on projects (sm8_job_uuid) where sm8_job_uuid is not null;

alter table clients add column if not exists sm8_company_uuid text;
create unique index if not exists clients_sm8_company_uuid_key on clients (sm8_company_uuid) where sm8_company_uuid is not null;
