-- Client portal, the rest of PR 2 (backlog item 74 points 1, 8 and 9; owner's "build all of it
-- now and straight to main", 18 Nov 2026).
--
--  * Requests for work: a client asks for a quote (with the date they need it by) or for a do and
--    charge job to be booked in (with one to three suggested days). Both become real projects at
--    once (a Q or a J number). projects.client_due_date and client_due_note (the date we work to,
--    and why we moved it), projects.client_suggested_dates, projects.portal_requested_at and
--    portal_requested_by (who asked, from which email).
--  * Messages on a job: job_client_messages, one thread per job between the client and us, shown
--    on the job's Feed tab apart from the team's notes. Written only by the server (portal-write.js
--    for the client, job-client-message.js for staff, which can email it); staff read.
--  * The People card: a client's main email adds or removes portal logins; each is a client contact
--    with the Portal tick (client_contacts.portal_access, already there). Nothing new in the table.
-- Additions only. No money, stock or payroll.

alter table public.projects
  add column if not exists client_due_date date,
  add column if not exists client_due_note text,
  add column if not exists client_suggested_dates date[],
  add column if not exists portal_requested_at timestamptz,
  add column if not exists portal_requested_by text;

create table if not exists public.job_client_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  from_email text,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (length(body) between 1 and 4000),
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  check (from_email is not null or author_id is not null)
);
create index if not exists job_client_messages_project on public.job_client_messages (project_id, created_at);
create index if not exists job_client_messages_author on public.job_client_messages (author_id);

alter table public.job_client_messages enable row level security;
revoke all on public.job_client_messages from public, anon, authenticated;
grant select on public.job_client_messages to authenticated;

drop policy if exists "Staff read client messages" on public.job_client_messages;
create policy "Staff read client messages" on public.job_client_messages
  for select to authenticated using (true);
