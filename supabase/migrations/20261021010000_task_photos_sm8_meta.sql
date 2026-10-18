-- Photos on tasks, and ServiceM8 photo details (spec A27, job tasks).
--
-- project_photos.task_id: a photo taken from a task (camera button on the task)
-- is a normal site photo, captioned "#task <task>", and linked back so the task
-- can show its photos. Deleting the task keeps the photo.
-- sm8_attachment_copies.meta_synced_at: when the copy last set a ServiceM8
-- file's real date and uploader on the photo or document, so files copied
-- before that existed are fixed once on the next run.

alter table public.project_photos add column if not exists task_id uuid references public.job_tasks(id) on delete set null;
create index if not exists project_photos_task_id_idx on public.project_photos (task_id) where task_id is not null;

alter table public.sm8_attachment_copies add column if not exists meta_synced_at timestamptz;
