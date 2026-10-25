-- ServiceM8 labour that an admin deleted on the job (wrong in ServiceM8). The ServiceM8 import
-- (netlify/functions/_shared/sm8-labour.js) skips every id in here, so a re-run does not bring it back.
-- Filled by a trigger on time_entries, so the row and its record go in the same transaction.
-- Server only: RLS on with no policies (the import and admin-update-time-entry.js use the service role).

create table if not exists public.sm8_deleted_activities (
  sm8_activity_uuid text primary key,
  project_id uuid,
  staff_id uuid,
  clock_in timestamptz,
  clock_out timestamptz,
  deleted_at timestamptz not null default now()
);
alter table public.sm8_deleted_activities enable row level security;
revoke all on table public.sm8_deleted_activities from anon, authenticated;

create or replace function public.time_entries_remember_sm8_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.sm8_activity_uuid is not null then
    insert into public.sm8_deleted_activities (sm8_activity_uuid, project_id, staff_id, clock_in, clock_out)
    values (old.sm8_activity_uuid, old.project_id, old.staff_id, old.clock_in, old.clock_out)
    on conflict (sm8_activity_uuid) do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists time_entries_remember_sm8_delete on public.time_entries;
create trigger time_entries_remember_sm8_delete
  after delete on public.time_entries
  for each row execute function public.time_entries_remember_sm8_delete();

revoke all on function public.time_entries_remember_sm8_delete() from public, anon, authenticated;
