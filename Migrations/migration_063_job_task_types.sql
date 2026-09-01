-- Migration 063 — Prejob vs onsite job tasks
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Splits job_tasks into two kinds: prejob tasks (office prep, handover
-- docs, anything to sort before the crew turns up) and onsite tasks (done
-- on the job site itself). Existing tasks default to prejob since the
-- feature up to now was mostly used for pre-scheduling admin checklist
-- items.

alter table job_tasks add column if not exists task_type text not null default 'prejob';

alter table job_tasks drop constraint if exists job_tasks_task_type_check;
alter table job_tasks add constraint job_tasks_task_type_check check (task_type in ('prejob', 'onsite'));
