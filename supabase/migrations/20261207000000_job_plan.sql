-- Job plan (backlog item 92, owner 17 Nov 2026): a Gantt style Plan view on the Schedule page.
--
--  * job_windows: one row per quote or job (the main bar, cost_centre_id null) and one per
--    variation cost centre. On-site days, crew, gear lead time, the start and finish, and the
--    dates the client was told (promised_start, promised_end). A quote's row has no dates: the
--    chart places it in the first gap that fits each time it is drawn.
--  * company_settings: the four numbers the plan runs on (hours in a site day, default crew,
--    default lead weeks, how many working days late a start may be before the client is told).
--  * profiles.on_tools: who counts in the crew load. Null follows the role (Staff counts).
--  * get_quote_wait(token): the "Estimated start" line for the client's proposal page.
--  * Every approved, unfinished job gets a row: dates from its first to last booking (already
--    told to the client when every one of those bookings was), or no dates when nothing is booked.
--
-- No money, stock or payroll. Person columns carry no foreign key on purpose (the same reason as
-- schedule_assignments.created_by: a second link to profiles makes profiles(...) joins ambiguous).

alter table public.company_settings
  add column if not exists plan_day_hours numeric(4,1) not null default 8,
  add column if not exists plan_crew_size integer not null default 2,
  add column if not exists plan_lead_weeks integer not null default 2,
  add column if not exists plan_slip_days integer not null default 2;

alter table public.profiles add column if not exists on_tools boolean;

create table if not exists public.job_windows (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_centre_id uuid references public.cost_centres(id) on delete cascade,
  onsite_days numeric(5,1) not null default 1 check (onsite_days > 0 and onsite_days <= 400),
  onsite_days_typed boolean not null default false,
  crew_size integer not null default 2 check (crew_size between 1 and 20),
  lead_weeks integer not null default 2 check (lead_weeks between 0 and 52),
  start_date date,
  end_date date,
  promised_start date,
  promised_end date,
  client_confirmed_at timestamptz,
  client_confirmed_by uuid,
  client_confirmed_how text check (client_confirmed_how in ('email', 'phone')),
  wait_text text,
  quoter_id uuid,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  check ((start_date is null) = (end_date is null))
);

create unique index if not exists job_windows_project_main on public.job_windows (project_id) where cost_centre_id is null;
create unique index if not exists job_windows_cost_centre on public.job_windows (cost_centre_id) where cost_centre_id is not null;
create index if not exists job_windows_project on public.job_windows (project_id);
create index if not exists job_windows_dates on public.job_windows (start_date, end_date);

alter table public.job_windows enable row level security;

drop policy if exists "Staff read job windows" on public.job_windows;
create policy "Staff read job windows" on public.job_windows
  for select to authenticated using (true);
drop policy if exists "Pricing roles add job windows" on public.job_windows;
create policy "Pricing roles add job windows" on public.job_windows
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change job windows" on public.job_windows;
create policy "Pricing roles change job windows" on public.job_windows
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove job windows" on public.job_windows;
create policy "Pricing roles remove job windows" on public.job_windows
  for delete to authenticated using ((select is_pricing_role()));

-- The wait line on the proposal. The quote's own token is the check, the same model as
-- get_quote_by_token; only a quote still open gets a line (a job or an approved quote does not).
create or replace function public.get_quote_wait(p_token text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select w.wait_text
  from projects p
  join job_windows w on w.project_id = p.id and w.cost_centre_id is null
  where p_token is not null and p.quote_token = p_token
    and p.job_number is null and p.status not in ('approved', 'declined')
  limit 1;
$$;
revoke execute on function public.get_quote_wait(text) from public;
grant execute on function public.get_quote_wait(text) to anon, authenticated;

-- Jobs already running.
insert into public.job_windows (project_id, onsite_days, crew_size, start_date, end_date, promised_start, promised_end, client_confirmed_at, client_confirmed_how, quoter_id)
select p.id,
  greatest(1, coalesce(b.days, 1)),
  least(20, greatest(1, coalesce(b.crew, 2))),
  b.first_day, b.last_day,
  case when b.all_told then b.first_day end,
  case when b.all_told then b.last_day end,
  case when b.all_told then b.told_at end,
  case when b.all_told then 'email' end,
  (select q.created_by from public.projects q where q.id = p.source_quote_id)
from public.projects p
left join lateral (
  select min(a.assignment_date) as first_day, max(a.assignment_date) as last_day,
    count(distinct a.assignment_date) as days,
    ceil(count(*)::numeric / nullif(count(distinct a.assignment_date), 0))::integer as crew,
    bool_and(a.client_informed_at is not null) as all_told,
    max(a.client_informed_at) as told_at
  from public.schedule_assignments a
  where a.project_id = p.id and a.block_type = 'job'
) b on true
where p.job_number is not null
  and p.pipeline_stage in ('quote_approved', 'deposit_paid', 'awaiting_action', 'awaiting_client_action', 'ready_to_book', 'job_booked', 'job_not_complete')
  and not exists (select 1 from public.job_windows w where w.project_id = p.id and w.cost_centre_id is null);
