-- Formbay webhooks: every event Formbay sends to /.netlify/functions/formbay-webhook is kept here
-- as it arrived (job.created, job.updated, job.deleted, doc.updated, and the webhook.test ping
-- Formbay sends before it saves a webhook). Formbay does not document the payload, so the raw
-- body is stored first; processing (matching to our jobs, pulling STC sale details) comes later
-- and marks rows with processed_at.

create table if not exists formbay_webhook_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event_type text,
  formbay_job_id text,
  payload jsonb,
  raw_body text,
  processed_at timestamptz,
  process_error text
);
create index if not exists formbay_webhook_events_received_idx on formbay_webhook_events (received_at desc);
create index if not exists formbay_webhook_events_job_idx on formbay_webhook_events (formbay_job_id);

alter table formbay_webhook_events enable row level security;
drop policy if exists "staff full access on formbay_webhook_events" on formbay_webhook_events;
create policy "staff full access on formbay_webhook_events" on formbay_webhook_events for all to authenticated using (true) with check (true);
