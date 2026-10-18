-- Email workers on the shared sales@ inbox (see netlify/functions/email-workers.js):
--   Postie      sorts every new incoming email (spam, customer, builder, supplier, other)
--   Bouncer     archives spam (out of the Inbox, never deleted, one-tap "Not spam")
--   Tagger      tags the conversation to a job when sure, suggests one when guessing
--   Ghostwriter drafts a reply when a customer, builder or supplier asks something
-- Nothing is ever sent by a worker.

-- Per email: where the workers are up to. null = not for the workers (sent by us,
-- or older mail synced before this existed).
alter table public.emails add column if not exists ai_status text;
alter table public.emails add column if not exists ai_category text;
alter table public.emails add column if not exists ai_attempts integer not null default 0;
alter table public.emails add column if not exists ai_error text;
alter table public.emails add column if not exists ai_processed_at timestamp with time zone;

alter table public.emails drop constraint if exists emails_ai_status_check;
alter table public.emails add constraint emails_ai_status_check
  check (ai_status is null or ai_status in ('pending', 'sorted', 'done', 'error'));
alter table public.emails drop constraint if exists emails_ai_category_check;
alter table public.emails add constraint emails_ai_category_check
  check (ai_category is null or ai_category in ('spam', 'customer', 'builder', 'supplier', 'other'));

create index if not exists emails_ai_queue_idx on public.emails (created_at) where ai_status in ('pending', 'sorted');

-- Per conversation: Bouncer's spam flag and Tagger's suggestion.
alter table public.email_threads add column if not exists spam_at timestamp with time zone;
alter table public.email_threads add column if not exists ai_suggested_project_id uuid;
alter table public.email_threads add column if not exists ai_suggested_reason text;

alter table public.email_threads drop constraint if exists email_threads_ai_suggested_project_id_fkey;
alter table public.email_threads add constraint email_threads_ai_suggested_project_id_fkey
  foreign key (ai_suggested_project_id) references public.projects(id) on delete set null;
create index if not exists email_threads_ai_suggested_project_idx on public.email_threads (ai_suggested_project_id);

-- Tags Tagger made itself, shown as "tagged by Tagger" with undo.
alter table public.email_job_links add column if not exists tagged_by_ai boolean not null default false;

-- Ghostwriter's drafts. One ready draft per conversation at a time.
create table if not exists public.email_drafts (
  id uuid default gen_random_uuid() not null primary key,
  thread_id uuid not null references public.email_threads(id) on delete cascade,
  reply_to_email_id uuid references public.emails(id) on delete cascade,
  body_text text not null,
  gmail_draft_id text,
  status text default 'ready' not null check (status in ('ready', 'used', 'dismissed')),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create index if not exists email_drafts_thread_idx on public.email_drafts (thread_id);
create index if not exists email_drafts_reply_to_email_idx on public.email_drafts (reply_to_email_id);

alter table public.email_drafts enable row level security;

-- Same reach as the shared inbox itself (every signed-in staff member). Drafts are
-- written by the worker with the service role; staff only read and update them.
drop policy if exists "staff read email_drafts" on public.email_drafts;
create policy "staff read email_drafts" on public.email_drafts for select to authenticated
  using ((select auth.uid()) is not null);
drop policy if exists "staff update email_drafts" on public.email_drafts;
create policy "staff update email_drafts" on public.email_drafts for update to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

grant select, update on public.email_drafts to authenticated;
grant select, insert, update, delete on public.email_drafts to service_role;

-- Master switch, in Settings > Google Workspace (Gmail).
alter table public.company_settings add column if not exists email_workers_on boolean not null default true;
