-- Shared inbox: tag a conversation to the jobs it relates to, and send attachments.
--
-- email_job_links: one row per (conversation, job). kind says why it is on the job
-- (a materials quote from a supplier, a client conversation...), note is free text.
-- Tags are on the whole conversation, so later replies stay attached automatically.
--
-- email-attachments: private bucket for files staff attach to an email they send.
-- (Quote PDFs and marked-up plans are attached straight from project-documents.)
create table if not exists email_job_links (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references email_threads(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null default 'other' check (kind in ('materials_quote', 'client', 'supplier', 'other')),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (thread_id, project_id)
);
create index if not exists email_job_links_project_idx on email_job_links (project_id);

alter table email_job_links enable row level security;
drop policy if exists "staff full access on email_job_links" on email_job_links;
create policy "staff full access on email_job_links" on email_job_links for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('email-attachments', 'email-attachments', false)
on conflict (id) do nothing;

drop policy if exists "staff can view email attachments" on storage.objects;
create policy "staff can view email attachments" on storage.objects for select to authenticated using (bucket_id = 'email-attachments');
drop policy if exists "staff can upload email attachments" on storage.objects;
create policy "staff can upload email attachments" on storage.objects for insert to authenticated with check (bucket_id = 'email-attachments');
drop policy if exists "staff can delete email attachments" on storage.objects;
create policy "staff can delete email attachments" on storage.objects for delete to authenticated using (bucket_id = 'email-attachments');
