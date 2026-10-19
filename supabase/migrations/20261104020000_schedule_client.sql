-- Job Schedule tab: client informed, client time options and the schedule email log
-- (docs/PROJECT_SPEC.md A34, docs/IDEAS_BACKLOG.md item 21).
--
-- schedule_assignments.created_by: who made the booking (the 7am reminder goes to them).
-- schedule_assignments.client_informed_at / client_informed_email_id: when the client was told
--   about this booking and by which email (null means tentative: Schedule and My Day show it dashed).
-- schedule_assignments.time_offer_id: the client time options this booking came from, if any.
-- schedule_time_offers: "Ask client to pick a time". We offer 2 to 6 start dates (each option is
--   `days` consecutive days, weekdays only when set) for the people in staff_ids at start_time to
--   end_time. The client opens /pick-time.html?token=... and picks one; book_time_offer() books
--   every person for every day of the option all or nothing, already marked client informed.
-- schedule_emails: every booking email sent to the client (confirmed, moved, cancelled, time
--   options, option picked), shown on the job's Schedule tab.
-- Written only by the server (service role) except the existing booking writes by pricing roles.

-- created_by has no foreign key on purpose: a second link from this table to profiles would make
-- the profiles(...) join in every schedule query ambiguous. Filled in by the browser (auth.uid())
-- and passed in by the server.
alter table public.schedule_assignments
  add column if not exists created_by uuid default auth.uid(),
  add column if not exists client_informed_at timestamptz,
  add column if not exists client_informed_email_id uuid references public.emails(id) on delete set null,
  add column if not exists time_offer_id uuid;

create index if not exists schedule_assignments_project_date_idx on public.schedule_assignments (project_id, assignment_date);
create index if not exists schedule_assignments_staff_date_idx on public.schedule_assignments (staff_id, assignment_date);
create index if not exists schedule_assignments_created_by_idx on public.schedule_assignments (created_by);
create index if not exists schedule_assignments_client_informed_email_idx on public.schedule_assignments (client_informed_email_id);
create index if not exists schedule_assignments_time_offer_idx on public.schedule_assignments (time_offer_id);

create table if not exists public.schedule_time_offers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  staff_ids uuid[] not null,
  start_time time not null,
  end_time time not null,
  days integer not null default 1 check (days between 1 and 10),
  weekdays_only boolean not null default true,
  option_dates date[] not null,
  message text,
  to_email text not null,
  to_name text,
  status text not null default 'open' check (status in ('open', 'picked', 'declined', 'withdrawn')),
  picked_date date,
  picked_at timestamptz,
  client_message text,
  email_id uuid references public.emails(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  viewed_at timestamptz,
  constraint schedule_time_offers_times_check check (end_time > start_time),
  constraint schedule_time_offers_options_check check (array_length(option_dates, 1) between 1 and 6),
  constraint schedule_time_offers_staff_check check (array_length(staff_ids, 1) >= 1)
);

create index if not exists schedule_time_offers_project_idx on public.schedule_time_offers (project_id, created_at desc);
create index if not exists schedule_time_offers_email_idx on public.schedule_time_offers (email_id);
create index if not exists schedule_time_offers_created_by_idx on public.schedule_time_offers (created_by);

alter table public.schedule_assignments
  drop constraint if exists schedule_assignments_time_offer_id_fkey;
alter table public.schedule_assignments
  add constraint schedule_assignments_time_offer_id_fkey
  foreign key (time_offer_id) references public.schedule_time_offers(id) on delete set null;

alter table public.schedule_time_offers enable row level security;

drop policy if exists "staff read schedule_time_offers" on public.schedule_time_offers;
create policy "staff read schedule_time_offers" on public.schedule_time_offers
  for select to authenticated using ((select auth.uid()) is not null);

create table if not exists public.schedule_emails (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('booking_confirmed', 'booking_moved', 'booking_cancelled', 'time_offer', 'time_offer_picked')),
  to_email text not null,
  subject text not null,
  email_id uuid references public.emails(id) on delete set null,
  thread_id uuid references public.email_threads(id) on delete set null,
  assignment_ids uuid[] not null default '{}',
  offer_id uuid references public.schedule_time_offers(id) on delete set null,
  sent_by uuid references public.profiles(id) on delete set null,
  sent_at timestamptz not null default now()
);

create index if not exists schedule_emails_project_idx on public.schedule_emails (project_id, sent_at desc);
create index if not exists schedule_emails_email_idx on public.schedule_emails (email_id);
create index if not exists schedule_emails_thread_idx on public.schedule_emails (thread_id);
create index if not exists schedule_emails_offer_idx on public.schedule_emails (offer_id);
create index if not exists schedule_emails_sent_by_idx on public.schedule_emails (sent_by);

alter table public.schedule_emails enable row level security;

drop policy if exists "staff read schedule_emails" on public.schedule_emails;
create policy "staff read schedule_emails" on public.schedule_emails
  for select to authenticated using ((select auth.uid()) is not null);

-- The dates one option covers: `days` days from the start, skipping weekends when weekdays_only.
create or replace function public.time_offer_option_dates(p_start date, p_days integer, p_weekdays_only boolean)
returns setof date
language sql
immutable
set search_path = public
as $$
  select d::date
  from generate_series(p_start, p_start + (p_days * 2 + 2), interval '1 day') d
  where not (p_weekdays_only and extract(isodow from d) in (6, 7))
  order by d
  limit greatest(p_days, 1);
$$;

revoke execute on function public.time_offer_option_dates(date, integer, boolean) from public, anon;
grant execute on function public.time_offer_option_dates(date, integer, boolean) to authenticated, service_role;

-- Each option of an offer with whether every person is still free on every one of its days.
create or replace function public.time_offer_option_status(p_offer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', o.start_date,
    'dates', (select jsonb_agg(d) from time_offer_option_dates(o.start_date, f.days, f.weekdays_only) d),
    'past', o.start_date < sydney_today(),
    'available', o.start_date >= sydney_today() and not exists (
      select 1
      from time_offer_option_dates(o.start_date, f.days, f.weekdays_only) d
      join schedule_assignments s on s.assignment_date = d and s.staff_id = any (f.staff_ids)
      where s.start_time < f.end_time and f.start_time < s.end_time
    )
  ) order by o.start_date), '[]'::jsonb)
  from schedule_time_offers f
  cross join lateral unnest(f.option_dates) as o(start_date)
  where f.id = p_offer_id;
$$;

revoke execute on function public.time_offer_option_status(uuid) from public, anon, authenticated;
grant execute on function public.time_offer_option_status(uuid) to service_role;

-- Books the option the client picked: every person in staff_ids for every day of the option,
-- all or nothing, already client informed. Raises 'taken' when someone is no longer free,
-- 'not_open' when the offer is not open, 'not_an_option' / 'in_the_past' for a bad date.
-- Called only by the server (pick-time.js) after it checked the private link token.
create or replace function public.book_time_offer(p_offer_id uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f schedule_time_offers%rowtype;
  v_block text;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_sid uuid;
  v_day date;
begin
  select * into f from schedule_time_offers where id = p_offer_id for update;
  if not found or f.status <> 'open' then raise exception 'not_open'; end if;
  if not (p_date = any (f.option_dates)) then raise exception 'not_an_option'; end if;
  if p_date < sydney_today() then raise exception 'in_the_past'; end if;

  -- lock the people's rows for those days so two picks cannot both get through
  perform 1 from schedule_assignments s
    where s.staff_id = any (f.staff_ids)
      and s.assignment_date in (select d from time_offer_option_dates(p_date, f.days, f.weekdays_only) d)
    for update;
  if exists (
    select 1
    from time_offer_option_dates(p_date, f.days, f.weekdays_only) d
    join schedule_assignments s on s.assignment_date = d and s.staff_id = any (f.staff_ids)
    where s.start_time < f.end_time and f.start_time < s.end_time
  ) then raise exception 'taken'; end if;

  select case when job_number is not null then 'job' else 'site_visit' end into v_block from projects where id = f.project_id;
  if v_block is null then raise exception 'not_open'; end if;

  foreach v_sid in array f.staff_ids loop
    for v_day in select d from time_offer_option_dates(p_date, f.days, f.weekdays_only) d loop
      insert into schedule_assignments (staff_id, project_id, block_type, assignment_date, start_time, end_time, created_by, client_informed_at, time_offer_id)
      values (v_sid, f.project_id, v_block, v_day, f.start_time, f.end_time, f.created_by, now(), f.id)
      returning id into v_id;
      v_ids := v_ids || v_id;
    end loop;
  end loop;

  update schedule_time_offers set status = 'picked', picked_date = p_date, picked_at = now() where id = f.id;
  return jsonb_build_object('assignment_ids', to_jsonb(v_ids), 'dates', (select jsonb_agg(d) from time_offer_option_dates(p_date, f.days, f.weekdays_only) d), 'block_type', v_block);
end;
$$;

revoke execute on function public.book_time_offer(uuid, date) from public, anon, authenticated;
grant execute on function public.book_time_offer(uuid, date) to service_role;
