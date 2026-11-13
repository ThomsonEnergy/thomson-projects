-- Recorded meetings: the audio is uploaded to a private bucket, transcribed
-- (speaker by speaker), then an AI pass drafts notes and per-job follow-up
-- actions from the transcript for someone to check before anything is saved.
--   project_ids : every job discussed (the AI only ever looks at these)
--   transcript  : [{ i, speaker, text, start, end }]  (start/end in ms)
--   ai_status   : null | transcribing | transcribed | analyzing | ready | approved | error
--   ai_draft    : the draft being reviewed (speaker names, notes, actions)
alter table meetings add column if not exists project_ids uuid[] not null default '{}';
alter table meetings add column if not exists audio_path text;
alter table meetings add column if not exists audio_seconds integer;
alter table meetings add column if not exists transcript_id text;
alter table meetings add column if not exists transcript jsonb;
alter table meetings add column if not exists ai_status text;
alter table meetings add column if not exists ai_error text;
alter table meetings add column if not exists ai_draft jsonb;
alter table meetings add column if not exists ai_updated_at timestamptz;
create index if not exists meetings_project_ids_idx on meetings using gin (project_ids);

-- anything already linked to a single job counts as "that job was discussed"
update meetings set project_ids = array[project_id] where project_id is not null and project_ids = '{}';

insert into storage.buckets (id, name, public)
values ('meeting-audio', 'meeting-audio', false)
on conflict (id) do nothing;

drop policy if exists "staff can view meeting audio" on storage.objects;
create policy "staff can view meeting audio"
  on storage.objects for select to authenticated
  using (bucket_id = 'meeting-audio');

drop policy if exists "staff can upload meeting audio" on storage.objects;
create policy "staff can upload meeting audio"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'meeting-audio');

drop policy if exists "staff can delete meeting audio" on storage.objects;
create policy "staff can delete meeting audio"
  on storage.objects for delete to authenticated
  using (bucket_id = 'meeting-audio');
