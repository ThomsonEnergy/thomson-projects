-- Document library for quotes/jobs - shared automatically between the two
-- since both are the same projects row (a quote just hasn't had a job_number
-- assigned yet). Organized into folders (a plain text field, not a separate
-- managed table - folders are created ad-hoc per project by typing a name).
-- Reuses the existing project-documents storage bucket and its policies from
-- migration_005 - no new bucket/storage policy needed.

create table if not exists project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  folder text not null default 'General',
  file_path text not null,
  file_name text not null,
  mime_type text,
  uploaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists project_documents_project_id_idx on project_documents (project_id);

alter table project_documents enable row level security;
drop policy if exists "staff full access on project_documents" on project_documents;
create policy "staff full access on project_documents"
  on project_documents for all to authenticated using (true) with check (true);
