-- Client portal, part 1 (backlog item 74, PR 1): who may log in, what they may see, and the
-- login tables. Clients are never Supabase auth users (every table policy assumes a logged-in
-- user is staff), so the portal reads and writes only through Netlify functions with the service
-- role (portal-login.js, portal-read.js, _shared/portal-session.js). The two new tables carry no
-- policies on purpose: nobody but the server touches them.

-- Who may log in: a ticked contact, or the client's main email (clients.email, always in).
alter table public.client_contacts add column if not exists portal_access boolean not null default false;

-- A client shut out of the portal (a dispute), and when they were last in.
alter table public.clients add column if not exists portal_off_at timestamptz;
alter table public.clients add column if not exists portal_off_reason text;
alter table public.clients add column if not exists portal_last_login_at timestamptz;

-- What the client may see: hidden until ticked on the job's Photos and Documents tabs.
alter table public.project_photos add column if not exists client_visible boolean not null default false;
alter table public.project_documents add column if not exists client_visible boolean not null default false;
create index if not exists project_photos_client_visible_idx on public.project_photos (project_id) where client_visible;
create index if not exists project_documents_client_visible_idx on public.project_documents (project_id) where client_visible;

-- One row per code emailed (or per attempt for an email we do not know, code_hash null). The code
-- itself is never stored, only its hash.
create table if not exists public.portal_logins (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text,
  ip text,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists portal_logins_email_idx on public.portal_logins (email, created_at desc);
create index if not exists portal_logins_ip_idx on public.portal_logins (ip, created_at desc);
alter table public.portal_logins enable row level security;

-- One row per device logged in. The token lives on the device; only its hash is here.
create table if not exists public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  email text not null,
  device text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create index if not exists portal_sessions_email_idx on public.portal_sessions (email) where ended_at is null;
alter table public.portal_sessions enable row level security;

revoke all on public.portal_logins from public, anon, authenticated;
revoke all on public.portal_sessions from public, anon, authenticated;

-- Anyone on the job may tick a document for the client (the photo policy already lets everyone
-- update a photo). The guard that keeps Staff to renames gains client_visible; nothing else changes.
create or replace function public.guard_project_documents_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
begin
  if v_uid is null or is_pricing_role() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.uploaded_by is distinct from v_uid then
      raise exception 'Only the person who uploaded this document, or Admin, Finance or Sales, can delete it.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.uploaded_by is distinct from v_uid then
      raise exception 'A document is always filed as yourself.';
    end if;
    if new.folder = 'Electricity bill' then
      raise exception 'Only Admin, Finance or Sales can file an electricity bill.';
    end if;
    return new;
  end if;
  -- UPDATE: rename pages, replace with a marked-up copy, save the plan summary, share with the client; nothing else
  for v_key in select key from jsonb_each(to_jsonb(new)) loop
    if v_key not in ('file_path', 'file_name', 'page_names', 'plan_summary', 'client_visible')
       and (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
      raise exception 'Only Admin, Finance or Sales can change % on a document.', v_key;
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.guard_project_documents_writes() from public, anon, authenticated;

-- The password login (owner, 11 Nov 2026: username is the email, a temporary password emailed when a
-- contact is ticked, changed on first login; the email code stays as the forgot-password path).
-- The hash is scrypt with a random salt (_shared/portal-session.js). Server only.
create table if not exists public.portal_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  must_change boolean not null default true,
  welcome_sent_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.portal_accounts enable row level security;
revoke all on public.portal_accounts from public, anon, authenticated;

-- What clients do in the portal (owner, 11 Nov 2026: a log on our end): one row per login, list
-- view, job view, and every quote, invoice, document or rates page opened from the portal. Written
-- by the server on every call; pricing roles read it on the Clients page. Kept 12 months.
create table if not exists public.portal_events (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  client_id uuid references public.clients(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists portal_events_client_idx on public.portal_events (client_id, created_at desc);
create index if not exists portal_events_project_idx on public.portal_events (project_id, created_at desc);
create index if not exists portal_events_created_idx on public.portal_events (created_at desc);
alter table public.portal_events enable row level security;
drop policy if exists "Pricing roles read portal events" on public.portal_events;
create policy "Pricing roles read portal events" on public.portal_events for select to authenticated using (is_pricing_role());
revoke all on public.portal_events from public, anon;
grant select on public.portal_events to authenticated;
