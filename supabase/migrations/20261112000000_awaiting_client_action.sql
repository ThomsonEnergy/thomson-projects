-- New pipeline stage: Awaiting Client Action (the client needs to do something: sign a form,
-- send photos, pick a date, pay a variation). Sits after Awaiting Our Action (key awaiting_action,
-- label renamed in the app only) and before Ready to Book. Moved by hand from the Pipeline board;
-- no automation moves a job into or out of it, so a job parked on the client stays put.
-- No row changes: only the allowed values grow by one.

alter table public.projects drop constraint if exists projects_pipeline_stage_check;
alter table public.projects add constraint projects_pipeline_stage_check CHECK (pipeline_stage = ANY (ARRAY[
  'lead', 'draft_quote', 'quote_sent', 'quote_approved', 'deposit_paid',
  'awaiting_action', 'awaiting_client_action', 'ready_to_book', 'job_booked', 'job_not_complete',
  'client_handover', 'ready_to_invoice', 'awaiting_payment', 'complete', 'archived'
]::text[]));
