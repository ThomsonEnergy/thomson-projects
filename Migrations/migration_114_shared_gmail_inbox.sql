-- Shared team inbox for sales@thomsonenergy.com.au (Gmail, Google
-- Workspace). Google's Client ID/Secret/refresh token and the last-synced
-- Gmail historyId all live in the existing api_keys table as new rows
-- (google_client_id, google_client_secret, google_refresh_token,
-- google_history_id, google_oauth_pending_state) - same as every other
-- integration already stores its credentials, no new secrets table.
--
-- email_threads/emails are deliberately visible to every active staff
-- member (RLS using(true), same blanket pattern as job_tasks) - this is a
-- shared inbox, not a per-user one, and is_read is a single shared flag
-- rather than per-user read state.

alter table profiles add column if not exists email_signature text;

create table if not exists email_threads (
  id uuid primary key default gen_random_uuid(),
  gmail_thread_id text unique not null,
  subject text,
  client_id uuid references clients(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  last_message_at timestamptz,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists email_threads_last_message_at_idx on email_threads (last_message_at desc);
create index if not exists email_threads_client_id_idx on email_threads (client_id);

create table if not exists emails (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references email_threads(id) on delete cascade,
  gmail_message_id text unique not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_address text,
  to_addresses text[],
  cc_addresses text[],
  subject text,
  body_text text,
  message_id_header text, -- the RFC 2822 Message-ID header, so a reply can set In-Reply-To/References for mail clients that thread on that rather than Gmail's own thread id
  sent_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists emails_thread_id_idx on emails (thread_id);

alter table email_threads enable row level security;
drop policy if exists "staff full access on email_threads" on email_threads;
create policy "staff full access on email_threads"
  on email_threads for all to authenticated using (true) with check (true);

alter table emails enable row level security;
drop policy if exists "staff full access on emails" on emails;
create policy "staff full access on emails"
  on emails for all to authenticated using (true) with check (true);
