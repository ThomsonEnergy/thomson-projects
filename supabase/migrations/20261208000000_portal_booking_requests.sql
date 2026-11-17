-- A client asks for a date and time on a job from the portal (backlog item 74 point 9a, owner
-- 17 Nov 2026, "yes, live now" 18 Nov 2026).
--
--  * portal_booking_requests: one row per ask. Written only by the server (portal-write.js) after
--    the portal session and its scope are checked; staff read it (the job's Schedule tab, the Plan
--    view). The ask books nothing.
--  * One open ask per job (a partial unique index). Withdraw or Change closes it.
--  * The ask closes by itself (answered_at) the moment any booking on that job from today on is
--    marked Client informed, whichever way that happens (Email booking, Mark as told, a client's
--    time pick): a trigger on schedule_assignments, so no code path can forget it.
-- Additions only. No money, stock or payroll.

create table if not exists public.portal_booking_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  ask_date date not null,
  ask_time time,
  note text check (note is null or length(note) <= 500),
  email text not null,
  session_id uuid references public.portal_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  withdrawn_at timestamptz,
  flagged_at timestamptz
);

create unique index if not exists portal_booking_requests_one_open on public.portal_booking_requests (project_id) where answered_at is null and withdrawn_at is null;
create index if not exists portal_booking_requests_project on public.portal_booking_requests (project_id);
create index if not exists portal_booking_requests_session on public.portal_booking_requests (session_id);

alter table public.portal_booking_requests enable row level security;
revoke all on public.portal_booking_requests from public, anon, authenticated;
grant select on public.portal_booking_requests to authenticated;

drop policy if exists "Staff read client date asks" on public.portal_booking_requests;
create policy "Staff read client date asks" on public.portal_booking_requests
  for select to authenticated using (true);

-- Telling the client about any booking on the job from today on answers its open ask.
create or replace function public.portal_booking_request_answered()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.project_id is not null and new.client_informed_at is not null
     and (tg_op = 'INSERT' or old.client_informed_at is null)
     and new.assignment_date >= sydney_today() then
    update portal_booking_requests set answered_at = now()
    where project_id = new.project_id and answered_at is null and withdrawn_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.portal_booking_request_answered() from public, anon, authenticated;

drop trigger if exists schedule_assignments_answer_client_ask on public.schedule_assignments;
create trigger schedule_assignments_answer_client_ask
  after insert or update of client_informed_at on public.schedule_assignments
  for each row execute function public.portal_booking_request_answered();
