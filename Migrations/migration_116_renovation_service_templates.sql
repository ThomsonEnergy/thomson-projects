-- Two new quote templates: 'renovation' and 'service_work'. Their
-- template-specific questions are saved as jsonb (keyed by question id, see
-- public/js/template-questions.js) and drive the job's default task list
-- (netlify/functions/_shared/create-default-job-tasks.js).
alter table projects add column if not exists template_answers jsonb not null default '{}'::jsonb;

alter table projects drop constraint if exists projects_proposal_template_check;
alter table projects add constraint projects_proposal_template_check
  check (proposal_template in ('new_build', 'solar', 'quick_estimate', 'time_and_materials', 'direct_job', 'renovation', 'service_work'));
