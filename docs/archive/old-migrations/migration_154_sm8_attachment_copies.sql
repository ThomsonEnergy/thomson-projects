-- Migration 154 - ServiceM8 docs and photos copy
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- After the open-jobs import (migration 153), sm8-copy-attachments-background.js
-- copies each imported job's ServiceM8 attachments into the job: pictures
-- into Photos (project_photos, site-photos bucket), everything else into
-- Documents (project_documents, "ServiceM8" folder).
--
-- One row per ServiceM8 attachment. It is both the progress the import
-- screen shows and what makes the copy safe to re-run: the unique
-- sm8_attachment_uuid means a file is only ever queued once, and a copied
-- row is never copied again (failed ones are retried).
-- Written only by the background function with the service role; admins
-- can read it for the progress display.

create table if not exists sm8_attachment_copies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  sm8_job_uuid text not null,
  sm8_attachment_uuid text not null unique,
  file_name text not null,
  kind text not null check (kind in ('photo', 'document')),
  -- 'copying' + claimed_at: a run claims a row before downloading it, so
  -- two runs at once never copy the same file twice. A claim older than
  -- the background function's 15 minute limit is a crashed run and is
  -- released back to pending.
  status text not null default 'pending' check (status in ('pending', 'copying', 'copied', 'failed')),
  claimed_at timestamptz,
  error text,
  project_photo_id uuid references project_photos(id) on delete set null,
  project_document_id uuid references project_documents(id) on delete set null,
  created_at timestamptz not null default now(),
  copied_at timestamptz
);

create index if not exists sm8_attachment_copies_status_idx on sm8_attachment_copies (status);

alter table sm8_attachment_copies enable row level security;
drop policy if exists "admins read sm8_attachment_copies" on sm8_attachment_copies;
create policy "admins read sm8_attachment_copies"
  on sm8_attachment_copies for select to authenticated using (is_admin());
