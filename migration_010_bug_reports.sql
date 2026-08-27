-- Bugs & System Updates page. Structured so a submission carries enough
-- context on its own to act on later - a bug report has "what happened"
-- and "what should happen instead" as separate fields, an update idea just
-- has "what do you want" as the description.

create table if not exists bug_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null default 'bug' check (report_type in ('bug', 'update_idea')),
  title text not null,
  page_or_feature text,
  description text not null,
  expected_behavior text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bug_reports_status_idx on bug_reports (status);

alter table bug_reports enable row level security;
drop policy if exists "staff full access on bug_reports" on bug_reports;
create policy "staff full access on bug_reports"
  on bug_reports for all to authenticated using (true) with check (true);
