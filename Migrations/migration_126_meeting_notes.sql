-- Meeting notes with follow-up actions. A meeting is a record of what was
-- discussed (optionally tied to a job); each action coming out of it is a
-- normal job_tasks row (so it already shows on Tasks / My Day and can be
-- ticked off there) with a few extra columns: which meeting it came from, a
-- reminder date/time, and a "follow-up confirmed" stamp so whoever ran the
-- meeting can confirm it was really dealt with.
create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  meeting_date date not null default current_date,
  meeting_time time,
  location text,
  project_id uuid references projects(id) on delete set null,
  attendee_ids uuid[] not null default '{}',
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists meetings_date_idx on meetings (meeting_date desc);
create index if not exists meetings_project_idx on meetings (project_id);

alter table job_tasks add column if not exists meeting_id uuid references meetings(id) on delete cascade;
alter table job_tasks add column if not exists remind_at timestamptz;
alter table job_tasks add column if not exists followed_up_at timestamptz;
alter table job_tasks add column if not exists followed_up_by uuid references profiles(id) on delete set null;
create index if not exists job_tasks_meeting_idx on job_tasks (meeting_id) where meeting_id is not null;
create index if not exists job_tasks_remind_idx on job_tasks (remind_at) where remind_at is not null and completed = false;

alter table meetings enable row level security;
drop policy if exists "staff full access on meetings" on meetings;
create policy "staff full access on meetings" on meetings for all to authenticated using (true) with check (true);
