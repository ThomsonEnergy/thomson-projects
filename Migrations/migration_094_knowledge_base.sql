-- Migration 094: Knowledge Base - install guides, best practices, AUS
-- standards, and other reference material staff can paste text into,
-- link a website to, or upload a file (PDF/image/spreadsheet) for. Each
-- entry stores an extracted plain-text `content` alongside the original
-- source so the new AI chatbox (see ai-chat.js) can search and answer
-- questions from it, not just from live business data.
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

create table if not exists knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text,
  entry_type text not null check (entry_type in ('text', 'website', 'file')),
  content text,
  source_url text,
  file_path text,
  file_name text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_entries_category_idx on knowledge_entries (category);

alter table knowledge_entries enable row level security;
drop policy if exists "staff full access on knowledge_entries" on knowledge_entries;
create policy "staff full access on knowledge_entries"
  on knowledge_entries for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('knowledge-files', 'knowledge-files', false)
on conflict (id) do nothing;

drop policy if exists "staff can view knowledge files" on storage.objects;
create policy "staff can view knowledge files"
  on storage.objects for select to authenticated
  using (bucket_id = 'knowledge-files');

drop policy if exists "staff can upload knowledge files" on storage.objects;
create policy "staff can upload knowledge files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'knowledge-files');

drop policy if exists "staff can delete knowledge files" on storage.objects;
create policy "staff can delete knowledge files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'knowledge-files');
