-- Two additions to Bugs & Updates:
--
-- 1. Approval - any active staff member can submit a bug/update idea, but
--    a scheduled Claude Code check should only ever act on ones that have
--    actually been reviewed and approved (admin, in Dev Mode). Unapproved
--    reports are excluded from BUGS_AND_UPDATES.md entirely, so a
--    scheduled check never even sees them.
--
-- 2. Comment threads - so a question about an approved report ("which
--    button exactly?") can be asked and answered right there, instead of
--    a report just silently sitting unresolved. author_type distinguishes
--    a staff reply from a note left by Claude itself (posted through
--    add-agent-comment.js, a separate secret-gated endpoint - see
--    SETUP.md).

alter table bug_reports add column if not exists approved_at timestamptz;
alter table bug_reports add column if not exists approved_by uuid references profiles(id) on delete set null;

create table if not exists bug_report_comments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references bug_reports(id) on delete cascade,
  author_type text not null default 'staff' check (author_type in ('staff', 'claude')),
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists bug_report_comments_report_id_idx on bug_report_comments (report_id);

alter table bug_report_comments enable row level security;
drop policy if exists "staff full access on bug_report_comments" on bug_report_comments;
create policy "staff full access on bug_report_comments"
  on bug_report_comments for all to authenticated using (true) with check (true);
