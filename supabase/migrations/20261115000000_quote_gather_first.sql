-- Gather first, generate last (docs/IDEAS_BACKLOG.md item 24).
-- 1. Battery as its own proposal template.
-- 2. The AI scope brief is saved on the quote so it can be edited later.
-- 3. STC count typed straight in on a stage (batteries: from usable kWh, not kW).
-- 4. Ready-to-send gate override (Admin / Finance send anyway with a reason; who is in activity_log).

alter table public.projects drop constraint if exists projects_proposal_template_check;
alter table public.projects add constraint projects_proposal_template_check
  check (proposal_template = any (array['new_build'::text, 'solar'::text, 'battery'::text, 'quick_estimate'::text, 'time_and_materials'::text, 'direct_job'::text, 'renovation'::text, 'service_work'::text]));

alter table public.projects add column if not exists sow_brief text default ''::text not null;
alter table public.projects add column if not exists send_gate_override_reason text;
alter table public.projects add column if not exists send_gate_override_at timestamp with time zone;

alter table public.cost_centres add column if not exists stc_quantity numeric;

comment on column public.projects.sow_brief is 'Notes typed for the AI scope of works draft (not shown to the client).';
comment on column public.projects.send_gate_override_reason is 'Why the quote was sent with ready-to-send gaps (Admin / Finance only).';
comment on column public.cost_centres.stc_quantity is 'Number of STCs typed in by hand; wins over the system size calculator when set.';
