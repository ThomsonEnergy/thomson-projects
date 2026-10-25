-- Contacts on every job (backlog item 33, 23 Oct 2026).
-- One row per person on a job or quote, in three groups (side):
--   site     the people at the site: owner, renter, builder, other trade, real estate agent, strata
--   client   the client's people: project manager, site manager, job contact, accounts, sales
--   thomson  ours: site manager, project manager, sales manager (profile_id points at the person)
-- Every active user reads and edits them (a tradie adds the builder's number on site). The
-- client's saved contacts (client_contacts) stay pricing-roles-only; a row picked from there
-- keeps the link in client_contact_id. The five projects.*_contact_id columns stay for the
-- old quote pickers' data and are carried in below; nothing new is written to them.

create table if not exists public.job_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  side text not null check (side in ('site', 'client', 'thomson')),
  role text not null,
  name text,
  company text,
  phone text,
  email text,
  notes text,
  profile_id uuid references public.profiles(id) on delete cascade,
  client_contact_id uuid references public.client_contacts(id) on delete set null,
  sort_order integer not null default 0,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint job_contacts_side_role check (
    (side = 'site' and role in ('owner', 'renter', 'builder', 'other_trade', 'real_estate', 'strata', 'other'))
    or (side = 'client' and role in ('project_manager', 'site_manager', 'job_contact', 'accounts', 'sales', 'other'))
    or (side = 'thomson' and role in ('site_manager', 'project_manager', 'sales_manager', 'other'))
  ),
  constraint job_contacts_who check (
    (side = 'thomson' and profile_id is not null)
    or (side <> 'thomson' and coalesce(btrim(name), '') <> '')
  )
);

create index if not exists job_contacts_project_id_idx on public.job_contacts (project_id);
create index if not exists job_contacts_profile_id_idx on public.job_contacts (profile_id);
create index if not exists job_contacts_client_contact_id_idx on public.job_contacts (client_contact_id);
create index if not exists job_contacts_created_by_idx on public.job_contacts (created_by);
-- One Thomson Energy site manager per job: the one the clock-out question goes to.
create unique index if not exists job_contacts_one_site_manager_uidx on public.job_contacts (project_id) where side = 'thomson' and role = 'site_manager';
-- The same person is not listed twice in the same role on one job.
create unique index if not exists job_contacts_profile_role_uidx on public.job_contacts (project_id, profile_id, role) where profile_id is not null;

alter table public.job_contacts enable row level security;

drop policy if exists "staff read job_contacts" on public.job_contacts;
create policy "staff read job_contacts" on public.job_contacts for select to authenticated using (true);
drop policy if exists "staff add job_contacts" on public.job_contacts;
create policy "staff add job_contacts" on public.job_contacts for insert to authenticated with check (true);
drop policy if exists "staff edit job_contacts" on public.job_contacts;
create policy "staff edit job_contacts" on public.job_contacts for update to authenticated using (true) with check (true);
drop policy if exists "staff remove job_contacts" on public.job_contacts;
create policy "staff remove job_contacts" on public.job_contacts for delete to authenticated using (true);

-- Carry in: every client contact linked through the five old columns becomes a client-side row.
insert into public.job_contacts (project_id, side, role, name, phone, email, client_contact_id, sort_order)
select p.id, 'client', m.role, coalesce(nullif(btrim(c.name), ''), c.phone, c.email), c.phone, c.email, c.id, m.ord
from public.projects p
cross join lateral (values
  (p.project_manager_contact_id, 'project_manager', 0),
  (p.site_contact_id, 'site_manager', 1),
  (p.job_contact_id, 'job_contact', 2),
  (p.sales_contact_id, 'sales', 3),
  (p.accounts_contact_id, 'accounts', 4)) as m(cid, role, ord)
join public.client_contacts c on c.id = m.cid
where coalesce(nullif(btrim(c.name), ''), c.phone, c.email) is not null
  and not exists (select 1 from public.job_contacts j where j.project_id = p.id and j.client_contact_id = c.id);

-- Site rank: who is asked "How's the job?" at clock-out when the job's Thomson site manager has
-- not clocked in that day. 1 is the most senior; blank falls back to the role (Admin 1,
-- Finance 2, Sales 3, Staff 9). Set on the Staff page.
alter table public.profiles add column if not exists site_rank integer check (site_rank between 1 and 99);

create index if not exists time_entries_project_id_clock_in_idx on public.time_entries (project_id, clock_in);

-- True when the signed-in user is the one to ask "How's the job?" at clock-out on this job today
-- (Sydney date): the job's Thomson Energy site manager if they clocked in on it today, else the
-- highest-ranking person who did (ties: who clocked in first). Nobody on the clock today (should
-- not happen, the caller just clocked out) asks everyone, as before.
create or replace function public.clockout_asks_me(p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := sydney_today();
  v_sm uuid;
  v_top uuid;
begin
  if v_uid is null or p_project_id is null then return false; end if;

  select d.staff_id into v_top
  from (
    select t.staff_id, min(t.clock_in) as first_in
    from time_entries t
    where t.project_id = p_project_id
      and ((t.clock_in at time zone 'Australia/Sydney')::date = v_today
        or (t.clock_out at time zone 'Australia/Sydney')::date = v_today)
    group by t.staff_id
  ) d
  join profiles p on p.id = d.staff_id
  order by coalesce(p.site_rank, case p.role when 'admin' then 1 when 'finance' then 2 when 'sales' then 3 else 9 end), d.first_in
  limit 1;
  if v_top is null then return true; end if;

  select jc.profile_id into v_sm
  from job_contacts jc
  where jc.project_id = p_project_id and jc.side = 'thomson' and jc.role = 'site_manager';
  if v_sm is not null and exists (
    select 1 from time_entries t
    where t.project_id = p_project_id and t.staff_id = v_sm
      and ((t.clock_in at time zone 'Australia/Sydney')::date = v_today
        or (t.clock_out at time zone 'Australia/Sydney')::date = v_today)
  ) then
    return v_sm = v_uid;
  end if;
  return v_top = v_uid;
end $$;

revoke execute on function public.clockout_asks_me(uuid) from public, anon;
grant execute on function public.clockout_asks_me(uuid) to authenticated;
