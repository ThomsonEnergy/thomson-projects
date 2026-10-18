-- Sales inbox and My inbox (docs/IDEAS_BACKLOG.md item 5, docs/PROJECT_SPEC.md A18).
--
-- mailboxes: sales@ (shared, every staff member) plus one row per person who
-- connects their own work Gmail (personal, private to them). Refresh tokens
-- for personal mailboxes live in mailbox_tokens, which only the server can
-- read. sales@ keeps its token in api_keys as before.
--
-- Threads in a personal mailbox are private to its owner unless tagged to a
-- job: then everyone sees them on the job (business records).
--
-- The email agent sorts each conversation into a section (priority = needs
-- a reply, other, updates = subscriptions and notifications), applies labels
-- (Gmail style, for non-job matters), tags jobs and drafts replies. Nothing
-- is sent without a person pressing Send.
--
-- gmail_connect_notices: the Workplace Surveillance Act notice shown before
-- someone connects their Gmail. Agree (and waive the 14 days) connects now;
-- don't agree means Connect is locked for 14 days from the notice.

-- ---------- mailboxes ----------

create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  kind text not null check (kind in ('shared', 'personal')),
  owner_id uuid references public.profiles(id) on delete cascade,
  scopes text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  history_id text,
  last_synced_at timestamptz,
  last_error text,
  -- first load of a personal mailbox: 60 days of mail into TEops
  backfill_page_token text,
  backfill_done_at timestamptz,
  -- clean up scan: every email in the inbox, summed up by sender
  cleanup_page_token text,
  cleanup_scanned integer not null default 0,
  cleanup_estimate integer,
  cleanup_started_at timestamptz,
  cleanup_done_at timestamptz,
  -- "mark everything older than N days as read", waiting for the background worker
  cleanup_read_older_days integer,
  -- one background worker per mailbox at a time
  busy_until timestamptz,
  created_at timestamptz not null default now(),
  constraint mailboxes_owner_check check ((kind = 'shared') = (owner_id is null))
);

create unique index if not exists mailboxes_owner_personal_idx on public.mailboxes (owner_id) where kind = 'personal';

insert into public.mailboxes (address, kind, connected_at)
values ('sales@thomsonenergy.com.au', 'shared', now())
on conflict (address) do nothing;

create table if not exists public.mailbox_tokens (
  mailbox_id uuid primary key references public.mailboxes(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

-- Visible mailboxes for the logged-in person: sales@ plus their own.
create or replace function public.my_mailbox_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from mailboxes where kind = 'shared' or owner_id = (select auth.uid())
$$;

revoke execute on function public.my_mailbox_ids() from public, anon;
grant execute on function public.my_mailbox_ids() to authenticated;

alter table public.mailboxes enable row level security;
alter table public.mailbox_tokens enable row level security;
-- mailbox_tokens: no policies on purpose, server only.

drop policy if exists "mailboxes select" on public.mailboxes;
create policy "mailboxes select" on public.mailboxes for select to authenticated
  using (kind = 'shared' or owner_id = (select auth.uid()));

-- ---------- threads and emails ----------

alter table public.email_threads
  add column if not exists mailbox_id uuid references public.mailboxes(id) on delete cascade,
  add column if not exists section text,
  add column if not exists section_reason text,
  add column if not exists section_by text,
  add column if not exists triaged_at timestamptz,
  add column if not exists is_done boolean not null default false,
  add column if not exists suggested_label text,
  add column if not exists suggested_project_id uuid references public.projects(id) on delete set null,
  add column if not exists ai_checked_at timestamptz,
  add column if not exists ai_claimed_at timestamptz,
  -- who wrote the newest message: Priority only lists conversations still waiting on us
  add column if not exists last_direction text;

alter table public.email_threads drop constraint if exists email_threads_section_check;
alter table public.email_threads add constraint email_threads_section_check
  check (section in ('priority', 'other', 'updates'));
alter table public.email_threads drop constraint if exists email_threads_section_by_check;
alter table public.email_threads add constraint email_threads_section_by_check
  check (section_by in ('ai', 'person', 'rule', 'gmail'));

update public.email_threads set mailbox_id = (select id from public.mailboxes where address = 'sales@thomsonenergy.com.au')
where mailbox_id is null;

-- Existing code that inserts threads (send-gmail, supplier emails) does not
-- name a mailbox: those are sales@.
create or replace function public.trg_email_thread_default_mailbox()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mailbox_id is null then
    select id into new.mailbox_id from mailboxes where kind = 'shared' order by created_at limit 1;
  end if;
  return new;
end $$;

drop trigger if exists email_thread_default_mailbox on public.email_threads;
create trigger email_thread_default_mailbox
  before insert on public.email_threads
  for each row execute function public.trg_email_thread_default_mailbox();

alter table public.email_threads alter column mailbox_id set not null;

-- A conversation never moves to another mailbox (that would make private mail shared).
create or replace function public.trg_email_thread_keep_mailbox()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mailbox_id is distinct from old.mailbox_id then
    raise exception 'A conversation cannot move to another mailbox';
  end if;
  return new;
end $$;

drop trigger if exists email_thread_keep_mailbox on public.email_threads;
create trigger email_thread_keep_mailbox
  before update on public.email_threads
  for each row execute function public.trg_email_thread_keep_mailbox();

-- Gmail ids are only unique within one mailbox.
alter table public.email_threads drop constraint if exists email_threads_gmail_thread_id_key;
alter table public.email_threads drop constraint if exists email_threads_mailbox_gmail_thread_key;
alter table public.email_threads add constraint email_threads_mailbox_gmail_thread_key unique (mailbox_id, gmail_thread_id);
alter table public.emails drop constraint if exists emails_gmail_message_id_key;
alter table public.emails drop constraint if exists emails_thread_gmail_message_key;
alter table public.emails add constraint emails_thread_gmail_message_key unique (thread_id, gmail_message_id);
create index if not exists emails_gmail_message_id_idx on public.emails (gmail_message_id);

update public.email_threads t set last_direction = (
  select e.direction from public.emails e where e.thread_id = t.id order by e.sent_at desc nulls last limit 1
) where last_direction is null;

create index if not exists email_threads_mailbox_idx on public.email_threads (mailbox_id, last_message_at desc);
create index if not exists email_threads_suggested_project_idx on public.email_threads (suggested_project_id);
create index if not exists email_threads_open_idx on public.email_threads (mailbox_id, section, last_message_at desc) where not is_done;
create index if not exists email_threads_untriaged_idx on public.email_threads (mailbox_id) where triaged_at is null;
create index if not exists email_job_links_thread_idx on public.email_job_links (thread_id);

alter table public.emails
  add column if not exists gmail_labels text[],
  add column if not exists list_unsubscribe text;

alter table public.email_job_links
  add column if not exists by_ai boolean not null default false;

-- Who can see a thread: its mailbox is theirs (or sales@), or it is tagged to a job.
create or replace function public.can_see_email_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from email_threads t
    join mailboxes m on m.id = t.mailbox_id
    where t.id = p_thread_id
      and (m.kind = 'shared' or m.owner_id = (select auth.uid())
           or exists (select 1 from email_job_links l where l.thread_id = t.id))
  )
$$;

revoke execute on function public.can_see_email_thread(uuid) from public, anon;
grant execute on function public.can_see_email_thread(uuid) to authenticated;

drop policy if exists "staff full access on email_threads" on public.email_threads;
drop policy if exists "email_threads select" on public.email_threads;
create policy "email_threads select" on public.email_threads for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids())
         or exists (select 1 from public.email_job_links l where l.thread_id = email_threads.id));
drop policy if exists "email_threads insert" on public.email_threads;
create policy "email_threads insert" on public.email_threads for insert to authenticated
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_threads update" on public.email_threads;
create policy "email_threads update" on public.email_threads for update to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()))
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_threads delete" on public.email_threads;
create policy "email_threads delete" on public.email_threads for delete to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));

drop policy if exists "staff full access on emails" on public.emails;
drop policy if exists "emails select" on public.emails;
create policy "emails select" on public.emails for select to authenticated
  using (public.can_see_email_thread(thread_id));
drop policy if exists "emails insert" on public.emails;
create policy "emails insert" on public.emails for insert to authenticated
  with check (public.can_see_email_thread(thread_id));
drop policy if exists "emails update" on public.emails;
create policy "emails update" on public.emails for update to authenticated
  using (public.can_see_email_thread(thread_id)) with check (public.can_see_email_thread(thread_id));
drop policy if exists "emails delete" on public.emails;
create policy "emails delete" on public.emails for delete to authenticated
  using (public.can_see_email_thread(thread_id));

-- Tagging a private thread to a job is up to the people who can see it.
drop policy if exists "staff full access on email_job_links" on public.email_job_links;
drop policy if exists "email_job_links select" on public.email_job_links;
create policy "email_job_links select" on public.email_job_links for select to authenticated using (true);
drop policy if exists "email_job_links insert" on public.email_job_links;
create policy "email_job_links insert" on public.email_job_links for insert to authenticated
  with check (public.can_see_email_thread(thread_id));
drop policy if exists "email_job_links update" on public.email_job_links;
create policy "email_job_links update" on public.email_job_links for update to authenticated
  using (public.can_see_email_thread(thread_id)) with check (public.can_see_email_thread(thread_id));
drop policy if exists "email_job_links delete" on public.email_job_links;
create policy "email_job_links delete" on public.email_job_links for delete to authenticated
  using (public.can_see_email_thread(thread_id));

-- ---------- labels ----------

create table if not exists public.email_labels (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  name text not null,
  description text,
  colour text,
  status text not null default 'open' check (status in ('open', 'done')),
  gmail_label_id text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists email_labels_mailbox_name_idx on public.email_labels (mailbox_id, lower(name));
create index if not exists email_labels_created_by_idx on public.email_labels (created_by);

create table if not exists public.email_thread_labels (
  thread_id uuid not null references public.email_threads(id) on delete cascade,
  label_id uuid not null references public.email_labels(id) on delete cascade,
  by_ai boolean not null default false,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (thread_id, label_id)
);

create index if not exists email_thread_labels_label_idx on public.email_thread_labels (label_id);
create index if not exists email_thread_labels_added_by_idx on public.email_thread_labels (added_by);

alter table public.email_labels enable row level security;
alter table public.email_thread_labels enable row level security;

drop policy if exists "email_labels select" on public.email_labels;
create policy "email_labels select" on public.email_labels for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_labels insert" on public.email_labels;
create policy "email_labels insert" on public.email_labels for insert to authenticated
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_labels update" on public.email_labels;
create policy "email_labels update" on public.email_labels for update to authenticated
  using (mailbox_id in (select public.my_mailbox_ids())) with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_labels delete" on public.email_labels;
create policy "email_labels delete" on public.email_labels for delete to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));

drop policy if exists "email_thread_labels select" on public.email_thread_labels;
create policy "email_thread_labels select" on public.email_thread_labels for select to authenticated
  using (label_id in (select id from public.email_labels));
drop policy if exists "email_thread_labels insert" on public.email_thread_labels;
create policy "email_thread_labels insert" on public.email_thread_labels for insert to authenticated
  with check (label_id in (select id from public.email_labels) and public.can_see_email_thread(thread_id));
drop policy if exists "email_thread_labels delete" on public.email_thread_labels;
create policy "email_thread_labels delete" on public.email_thread_labels for delete to authenticated
  using (label_id in (select id from public.email_labels));

-- ---------- drafts ----------

create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  thread_id uuid references public.email_threads(id) on delete cascade,
  to_addresses text,
  cc_addresses text,
  subject text,
  body_text text not null default '',
  status text not null default 'draft' check (status in ('draft', 'sent', 'discarded')),
  by_ai boolean not null default false,
  gmail_draft_id text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_drafts_mailbox_idx on public.email_drafts (mailbox_id, status);
create index if not exists email_drafts_thread_idx on public.email_drafts (thread_id);
create index if not exists email_drafts_created_by_idx on public.email_drafts (created_by);
-- one open agent draft per conversation
create unique index if not exists email_drafts_one_ai_draft_idx on public.email_drafts (thread_id) where status = 'draft' and by_ai;

alter table public.email_drafts enable row level security;

drop policy if exists "email_drafts select" on public.email_drafts;
create policy "email_drafts select" on public.email_drafts for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_drafts insert" on public.email_drafts;
create policy "email_drafts insert" on public.email_drafts for insert to authenticated
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_drafts update" on public.email_drafts;
create policy "email_drafts update" on public.email_drafts for update to authenticated
  using (mailbox_id in (select public.my_mailbox_ids())) with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_drafts delete" on public.email_drafts;
create policy "email_drafts delete" on public.email_drafts for delete to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));

-- ---------- sender rules ("always do this for this sender") ----------

create table if not exists public.email_sender_rules (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  sender text not null,
  section text not null check (section in ('priority', 'other', 'updates')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists email_sender_rules_mailbox_sender_idx on public.email_sender_rules (mailbox_id, lower(sender));
create index if not exists email_sender_rules_created_by_idx on public.email_sender_rules (created_by);

alter table public.email_sender_rules enable row level security;

drop policy if exists "email_sender_rules select" on public.email_sender_rules;
create policy "email_sender_rules select" on public.email_sender_rules for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_sender_rules insert" on public.email_sender_rules;
create policy "email_sender_rules insert" on public.email_sender_rules for insert to authenticated
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_sender_rules update" on public.email_sender_rules;
create policy "email_sender_rules update" on public.email_sender_rules for update to authenticated
  using (mailbox_id in (select public.my_mailbox_ids())) with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_sender_rules delete" on public.email_sender_rules;
create policy "email_sender_rules delete" on public.email_sender_rules for delete to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));

-- ---------- clean up (every email in the inbox, by sender) ----------

create table if not exists public.mailbox_cleanup_senders (
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  sender text not null,
  sender_name text,
  inbox_count integer not null default 0,
  unread_count integer not null default 0,
  latest_at timestamptz,
  sample_subjects text[],
  gmail_category text,
  list_unsubscribe text,
  one_click_unsubscribe boolean not null default false,
  suggestion text check (suggestion in ('archive', 'keep', 'look')),
  suggestion_reason text,
  queued_action text check (queued_action in ('archive', 'read', 'unsubscribe')),
  done_action text,
  done_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (mailbox_id, sender)
);

alter table public.mailbox_cleanup_senders enable row level security;

drop policy if exists "mailbox_cleanup_senders select" on public.mailbox_cleanup_senders;
create policy "mailbox_cleanup_senders select" on public.mailbox_cleanup_senders for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));

-- ---------- Gmail connect notice (Workplace Surveillance Act 2005 (NSW)) ----------

create table if not exists public.gmail_connect_notices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  response text not null check (response in ('agree', 'disagree')),
  waived_notice boolean not null default false,
  notice_version integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists gmail_connect_notices_profile_idx on public.gmail_connect_notices (profile_id, created_at desc);

alter table public.gmail_connect_notices enable row level security;

drop policy if exists "gmail_connect_notices select" on public.gmail_connect_notices;
create policy "gmail_connect_notices select" on public.gmail_connect_notices for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.current_profile_role()) = 'admin');
drop policy if exists "gmail_connect_notices insert" on public.gmail_connect_notices;
create policy "gmail_connect_notices insert" on public.gmail_connect_notices for insert to authenticated
  with check (profile_id = (select auth.uid()));

-- Never trust the browser's clock or "agree" without the waiver.
create or replace function public.trg_gmail_connect_notice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  new.waived_notice := new.response = 'agree';
  return new;
end $$;

drop trigger if exists gmail_connect_notice on public.gmail_connect_notices;
create trigger gmail_connect_notice
  before insert on public.gmail_connect_notices
  for each row execute function public.trg_gmail_connect_notice();

-- When the logged-in person may connect their Gmail: now if they agreed,
-- otherwise 14 days after they were first shown the notice. Null = never shown.
create or replace function public.gmail_connect_allowed_from(p_profile_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case
    when bool_or(response = 'agree') then min(created_at) filter (where response = 'agree')
    else min(created_at) + interval '14 days'
  end
  from gmail_connect_notices
  where profile_id = p_profile_id
  having count(*) > 0
$$;

revoke execute on function public.gmail_connect_allowed_from(uuid) from public, anon, authenticated;
grant execute on function public.gmail_connect_allowed_from(uuid) to service_role;

-- ---------- notifications ----------

-- "New email" pushes: sales@ to admin and sales as before. Personal mailboxes
-- get none here: the email agent tells the owner about Priority mail itself.
CREATE OR REPLACE FUNCTION public.trg_notify_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_kind text;
begin
  if new.direction <> 'inbound' then return new; end if;
  if new.sent_at is not null and new.sent_at < now() - interval '1 day' then return new; end if;
  if exists (select 1 from email_threads where id = new.thread_id and is_supplier_bill) then return new; end if;
  select m.kind into v_kind from email_threads t join mailboxes m on m.id = t.mailbox_id where t.id = new.thread_id;
  if v_kind is distinct from 'shared' then return new; end if;
  for r in select id from profiles where active and role in ('admin', 'sales') loop
    perform create_notification(r.id, 'email', 'New email: ' || coalesce(nullif(new.subject, ''), '(no subject)'), 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html', null, 'email:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $function$
;

grant select on public.mailboxes, public.email_labels, public.email_thread_labels, public.email_drafts,
  public.email_sender_rules, public.mailbox_cleanup_senders, public.gmail_connect_notices to authenticated;
grant insert, update, delete on public.email_labels, public.email_thread_labels, public.email_drafts, public.email_sender_rules to authenticated;
grant insert on public.gmail_connect_notices to authenticated;
grant select, insert, update, delete on public.mailboxes, public.mailbox_tokens, public.email_labels, public.email_thread_labels,
  public.email_drafts, public.email_sender_rules, public.mailbox_cleanup_senders, public.gmail_connect_notices to service_role;
