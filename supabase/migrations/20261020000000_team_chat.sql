-- Team chat (replaces WhatsApp, docs/AI_AGENTS_PLAN.md "Team chat").
--
-- Channels (General and Social for everyone, plus channels an admin makes)
-- and DMs (one to one or small groups). Messages can have photos, files and
-- voice messages (private "chat" bucket, folder = channel id), @mentions,
-- threaded replies and a job tag. Sparky (the AI) tags messages to jobs and
-- answers when @mentioned, only for people with AI consent
-- (profiles.ai_consent_at), and only for messages sent after that consent.
--
-- Staff only ever insert their own messages and read channels they are in.
-- Everything else (edit, delete, tag, read markers, making channels) goes
-- through the security definer functions below. AI columns are only written
-- by the server (service role).

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'channel',
  name text,
  description text,
  slug text unique,
  is_social boolean not null default false,
  everyone boolean not null default false,
  dm_key text unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  last_message_at timestamptz,
  constraint chat_channels_kind_check check (kind in ('channel', 'dm')),
  constraint chat_channels_name_check check (kind = 'dm' or coalesce(trim(name), '') <> '')
);

create index if not exists chat_channels_created_by_idx on public.chat_channels (created_by);

create table if not exists public.chat_members (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (channel_id, profile_id)
);

create index if not exists chat_members_profile_id_idx on public.chat_members (profile_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  is_bot boolean not null default false,
  parent_id uuid references public.chat_messages(id) on delete cascade,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  mention_ids uuid[] not null default '{}',
  project_id uuid references public.projects(id) on delete set null,
  tagged_by text,
  tagged_by_profile_id uuid references public.profiles(id) on delete set null,
  tag_suggested_project_id uuid references public.projects(id) on delete set null,
  tag_rejected_project_ids uuid[] not null default '{}',
  voice_transcript text,
  ai_processed_at timestamptz,
  ai_asked_at timestamptz,
  reply_count integer not null default 0,
  last_reply_at timestamptz,
  client_id text unique,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint chat_messages_tagged_by_check check (tagged_by is null or tagged_by in ('person', 'ai')),
  constraint chat_messages_attachments_check check (jsonb_typeof(attachments) = 'array')
);

create index if not exists chat_messages_channel_created_idx on public.chat_messages (channel_id, created_at desc);
create index if not exists chat_messages_author_id_idx on public.chat_messages (author_id);
create index if not exists chat_messages_parent_id_idx on public.chat_messages (parent_id);
create index if not exists chat_messages_project_id_idx on public.chat_messages (project_id);
create index if not exists chat_messages_tagged_by_profile_id_idx on public.chat_messages (tagged_by_profile_id);
create index if not exists chat_messages_tag_suggested_project_id_idx on public.chat_messages (tag_suggested_project_id);
create index if not exists chat_messages_ai_pending_idx on public.chat_messages (created_at) where ai_processed_at is null;

-- ============================================================
-- Membership check (General, Social and other "everyone" channels
-- include every active staff member without needing a row)
-- ============================================================

create or replace function public.is_chat_member(p_channel uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from chat_channels c
    where c.id = p_channel
      and (
        exists (select 1 from chat_members m where m.channel_id = c.id and m.profile_id = (select auth.uid()))
        or (c.everyone and exists (select 1 from profiles p where p.id = (select auth.uid()) and p.active))
      )
  )
$$;

-- Storage paths are "<channel id>/<file>"; a bad folder name is just "no".
create or replace function public.chat_can_access_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return is_chat_member(split_part(p_name, '/', 1)::uuid);
exception when others then
  return false;
end $$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.chat_channels enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "Members read chat channels" on public.chat_channels;
create policy "Members read chat channels" on public.chat_channels for select to authenticated
  using ((select is_chat_member(id)));

drop policy if exists "Members read chat members" on public.chat_members;
create policy "Members read chat members" on public.chat_members for select to authenticated
  using ((select is_chat_member(channel_id)));

drop policy if exists "Members read chat messages" on public.chat_messages;
create policy "Members read chat messages" on public.chat_messages for select to authenticated
  using ((select is_chat_member(channel_id)));

drop policy if exists "Members send chat messages" on public.chat_messages;
create policy "Members send chat messages" on public.chat_messages for insert to authenticated
  with check (author_id = (select auth.uid()) and not is_bot and (select is_chat_member(channel_id)));

grant select on public.chat_channels, public.chat_members to authenticated;
grant select, insert on public.chat_messages to authenticated;
grant select, insert, update, delete on public.chat_channels, public.chat_members, public.chat_messages to service_role;

-- ============================================================
-- Before insert: staff can't set the AI or counter columns, the time is
-- the moment they pressed send (from the phone, so an offline message keeps
-- its real time) unless it is in the future or over a week old, and a reply
-- must be in the same channel as the message it replies to.
-- ============================================================

create or replace function public.trg_chat_message_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent chat_messages%rowtype;
begin
  if (select auth.uid()) is not null then
    new.is_bot := false;
    new.voice_transcript := null;
    new.ai_processed_at := null;
    new.ai_asked_at := null;
    new.tag_suggested_project_id := null;
    new.tag_rejected_project_ids := '{}';
    new.reply_count := 0;
    new.last_reply_at := null;
    new.edited_at := null;
    new.deleted_at := null;
    if new.project_id is not null then
      new.tagged_by := 'person';
      new.tagged_by_profile_id := (select auth.uid());
    else
      new.tagged_by := null;
      new.tagged_by_profile_id := null;
    end if;
  end if;
  if new.created_at is null or new.created_at > now() + interval '1 minute' or new.created_at < now() - interval '7 days' then
    new.created_at := now();
  end if;
  if new.parent_id is not null then
    select * into v_parent from chat_messages where id = new.parent_id;
    if not found or v_parent.channel_id <> new.channel_id then
      raise exception 'That reply belongs to a different chat';
    end if;
    if v_parent.parent_id is not null then
      new.parent_id := v_parent.parent_id;
    end if;
  end if;
  new.mention_ids := coalesce(array(select distinct x from unnest(new.mention_ids) x where x is not null), '{}');
  return new;
end $$;

drop trigger if exists chat_message_before_insert on public.chat_messages;
create trigger chat_message_before_insert
  before insert on public.chat_messages
  for each row execute function public.trg_chat_message_before_insert();

-- ============================================================
-- After insert: channel and thread counters, then notifications.
-- Who gets one: everyone in the chat except the sender, unless they muted
-- it (an @mention or a DM still gets through). A thread reply in a channel
-- only goes to people already in that thread. Sparky's replies only go to
-- whoever asked (in mention_ids). Each kind can be switched off in the
-- notification settings.
-- ============================================================

create or replace function public.trg_chat_message_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chan chat_channels%rowtype;
  v_name text;
  v_title text;
  v_body text;
  v_link text;
  v_kind text;
  r record;
begin
  update chat_channels set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at) where id = new.channel_id;
  if new.parent_id is not null then
    update chat_messages set reply_count = reply_count + 1, last_reply_at = new.created_at where id = new.parent_id;
  end if;

  begin
    select * into v_chan from chat_channels where id = new.channel_id;
    if new.is_bot then
      v_name := coalesce((select nullif(trim(ai_assistant_name), '') from company_settings where id = 1), 'Sparky');
    else
      select full_name into v_name from profiles where id = new.author_id;
    end if;
    v_name := coalesce(v_name, 'Someone');
    v_body := case
      when coalesce(trim(new.body), '') <> '' then new.body
      when new.attachments @> '[{"kind":"voice"}]' then 'Voice message'
      when new.attachments @> '[{"kind":"image"}]' then 'Photo'
      else 'File' end;
    v_link := '/chat.html?c=' || new.channel_id || case when new.parent_id is not null then '&t=' || new.parent_id else '' end || '&m=' || new.id;

    for r in
      select p.id, coalesce(m.muted, false) as muted
      from profiles p
      left join chat_members m on m.channel_id = new.channel_id and m.profile_id = p.id
      where p.active
        and p.id is distinct from new.author_id
        and (m.profile_id is not null or v_chan.everyone)
    loop
      if new.is_bot and not (r.id = any(new.mention_ids)) then continue; end if;
      if r.id = any(new.mention_ids) then
        v_kind := 'chat_mention';
      elsif v_chan.kind = 'dm' then
        v_kind := 'chat_dm';
      elsif new.parent_id is not null and exists (
        select 1 from chat_messages t
        where (t.id = new.parent_id or t.parent_id = new.parent_id) and t.author_id = r.id
      ) then
        v_kind := 'chat_reply';
      elsif new.parent_id is not null then
        continue;
      else
        v_kind := 'chat_message';
      end if;
      if r.muted and v_kind in ('chat_message', 'chat_reply') then continue; end if;

      v_title := case
        when v_chan.kind = 'dm' then v_name
        when v_kind = 'chat_mention' then v_name || ' mentioned you in #' || v_chan.name
        when v_kind = 'chat_reply' then v_name || ' replied in #' || v_chan.name
        else v_name || ' in #' || v_chan.name end;
      perform create_notification(r.id, v_kind, v_title, v_body, v_link, new.author_id, 'chat:' || new.id);
    end loop;
  exception when others then
    raise warning 'chat notification trigger failed: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists chat_message_after_insert on public.chat_messages;
create trigger chat_message_after_insert
  after insert on public.chat_messages
  for each row execute function public.trg_chat_message_after_insert();

-- ============================================================
-- Functions the app calls
-- ============================================================

-- The chat list: every chat I'm in, newest first, with unread counts and
-- the last message. DMs carry the other people's names and photos. Thread
-- replies only count as unread when they @mention me (the reply count on
-- the message shows the rest).
create or replace function public.chat_my_channels()
returns table (
  id uuid, kind text, name text, description text, slug text, is_social boolean, everyone boolean,
  archived_at timestamptz, last_message_at timestamptz, muted boolean, last_read_at timestamptz,
  unread integer, mention_unread integer, members jsonb, last_body text, last_author text, last_is_bot boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select (select auth.uid()) as uid),
  mine as (
    select c.*, m.muted, m.last_read_at as read_at
    from chat_channels c
    cross join me
    left join chat_members m on m.channel_id = c.id and m.profile_id = me.uid
    where (m.profile_id is not null or (c.everyone and exists (select 1 from profiles p where p.id = me.uid and p.active)))
  )
  select c.id, c.kind, c.name, c.description, c.slug, c.is_social, c.everyone, c.archived_at, c.last_message_at,
    coalesce(c.muted, false),
    coalesce(c.read_at, now() - interval '3 days'),
    (select count(*)::int from chat_messages x
      where x.channel_id = c.id and x.deleted_at is null and x.author_id is distinct from (select uid from me)
        and (x.parent_id is null or (select uid from me) = any(x.mention_ids))
        and x.created_at > coalesce(c.read_at, now() - interval '3 days')),
    (select count(*)::int from chat_messages x
      where x.channel_id = c.id and x.deleted_at is null and (select uid from me) = any(x.mention_ids)
        and x.created_at > coalesce(c.read_at, now() - interval '3 days')),
    case when c.kind = 'dm' then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'photo_url', p.photo_url) order by p.full_name), '[]'::jsonb)
      from chat_members m join profiles p on p.id = m.profile_id
      where m.channel_id = c.id and m.profile_id <> (select uid from me)
    ) else null end,
    l.body, l.author, l.is_bot
  from mine c
  left join lateral (
    select case when x.deleted_at is not null then 'Message deleted'
                when coalesce(trim(x.body), '') <> '' then left(x.body, 140)
                when x.attachments @> '[{"kind":"voice"}]' then 'Voice message'
                when x.attachments @> '[{"kind":"image"}]' then 'Photo'
                else 'File' end as body,
           p.full_name as author, x.is_bot
    from chat_messages x left join profiles p on p.id = x.author_id
    where x.channel_id = c.id and x.parent_id is null
    order by x.created_at desc limit 1
  ) l on true
  order by c.archived_at nulls first, c.last_message_at desc nulls last, c.name
$$;

-- Opens (or makes) the DM between me and these people.
create or replace function public.chat_open_dm(p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
  v_ids uuid[];
  v_key text;
  v_id uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select array_agg(distinct x order by x) into v_ids
  from unnest(coalesce(p_member_ids, '{}') || v_me) x
  where x in (select id from profiles where active) or x = v_me;
  if coalesce(array_length(v_ids, 1), 0) < 2 then raise exception 'Pick at least one person'; end if;
  if array_length(v_ids, 1) > 12 then raise exception 'A group message can have up to 12 people. Ask an admin for a channel instead.'; end if;
  v_key := array_to_string(v_ids, ',');
  select id into v_id from chat_channels where dm_key = v_key;
  if v_id is null then
    insert into chat_channels (kind, dm_key, created_by) values ('dm', v_key, v_me)
    on conflict (dm_key) do nothing
    returning id into v_id;
    if v_id is null then select id into v_id from chat_channels where dm_key = v_key; end if;
    insert into chat_members (channel_id, profile_id) select v_id, x from unnest(v_ids) x on conflict do nothing;
  end if;
  return v_id;
end $$;

-- Admin: make a channel, for everyone or for chosen people.
create or replace function public.chat_create_channel(p_name text, p_description text, p_everyone boolean, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
begin
  if not is_admin() then raise exception 'Only an admin can make channels'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the channel a name'; end if;
  insert into chat_channels (kind, name, description, everyone, created_by)
  values ('channel', trim(p_name), nullif(trim(coalesce(p_description, '')), ''), coalesce(p_everyone, false), v_me)
  returning id into v_id;
  if not coalesce(p_everyone, false) then
    insert into chat_members (channel_id, profile_id)
    select v_id, x from unnest(coalesce(p_member_ids, '{}') || v_me) x
    where x in (select id from profiles where active)
    on conflict do nothing;
  end if;
  return v_id;
end $$;

-- Admin: rename, describe, archive or restore a channel, and change who is
-- in it (people taken out keep nothing; General and Social stay for everyone).
create or replace function public.chat_update_channel(p_channel uuid, p_name text, p_description text, p_archived boolean, p_everyone boolean, p_member_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chan chat_channels%rowtype;
begin
  if not is_admin() then raise exception 'Only an admin can change channels'; end if;
  select * into v_chan from chat_channels where id = p_channel and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the channel a name'; end if;
  update chat_channels set
    name = trim(p_name),
    description = nullif(trim(coalesce(p_description, '')), ''),
    archived_at = case when coalesce(p_archived, false) and slug is null then coalesce(archived_at, now()) when not coalesce(p_archived, false) then null else archived_at end,
    everyone = case when slug is not null then true else coalesce(p_everyone, everyone) end
  where id = p_channel;
  if v_chan.slug is null and not coalesce(p_everyone, v_chan.everyone) and p_member_ids is not null then
    delete from chat_members where channel_id = p_channel and not (profile_id = any(p_member_ids));
    insert into chat_members (channel_id, profile_id)
    select p_channel, x from unnest(p_member_ids) x where x in (select id from profiles where active)
    on conflict do nothing;
  end if;
end $$;

-- Marks a chat read up to now, and clears its chat notifications.
create or replace function public.chat_mark_read(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if not is_chat_member(p_channel) then return; end if;
  insert into chat_members (channel_id, profile_id, last_read_at) values (p_channel, v_me, now())
  on conflict (channel_id, profile_id) do update set last_read_at = now();
  update notifications set read_at = now()
  where user_id = v_me and read_at is null and kind like 'chat%' and link like '/chat.html?c=' || p_channel || '%';
end $$;

create or replace function public.chat_set_muted(p_channel uuid, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_chat_member(p_channel) then raise exception 'Not in that chat'; end if;
  insert into chat_members (channel_id, profile_id, muted) values (p_channel, (select auth.uid()), coalesce(p_muted, false))
  on conflict (channel_id, profile_id) do update set muted = coalesce(p_muted, false);
end $$;

-- Edit my own message.
create or replace function public.chat_edit_message(p_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_body), '') = '' then raise exception 'A message cannot be empty'; end if;
  update chat_messages set body = p_body, edited_at = now()
  where id = p_id and author_id = (select auth.uid()) and deleted_at is null and not is_bot;
  if not found then raise exception 'You can only edit your own messages'; end if;
end $$;

-- Delete my own message (admins can delete any). Returns the attachment
-- paths so the app can remove the files.
create or replace function public.chat_delete_message(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg chat_messages%rowtype;
begin
  select * into v_msg from chat_messages where id = p_id;
  if not found or not (v_msg.author_id = (select auth.uid()) or (is_admin() and is_chat_member(v_msg.channel_id))) then
    raise exception 'You can only delete your own messages';
  end if;
  update chat_messages set body = '', attachments = '[]'::jsonb, voice_transcript = null, mention_ids = '{}',
    project_id = null, tagged_by = null, tagged_by_profile_id = null, tag_suggested_project_id = null, deleted_at = now()
  where id = p_id;
  return v_msg.attachments;
end $$;

-- Tag a message to a job, or take the tag off (p_project null). Anyone in
-- the chat can. Taking off a tag Sparky put on stops Sparky trying that job
-- again for this message.
create or replace function public.chat_set_tag(p_id uuid, p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg chat_messages%rowtype;
begin
  select * into v_msg from chat_messages where id = p_id and deleted_at is null;
  if not found or not is_chat_member(v_msg.channel_id) then raise exception 'Message not found'; end if;
  update chat_messages set
    project_id = p_project,
    tagged_by = case when p_project is null then null else 'person' end,
    tagged_by_profile_id = case when p_project is null then null else (select auth.uid()) end,
    tag_suggested_project_id = null,
    tag_rejected_project_ids = case
      when p_project is null and v_msg.project_id is not null and not (v_msg.project_id = any(tag_rejected_project_ids))
        then tag_rejected_project_ids || v_msg.project_id
      else tag_rejected_project_ids end
  where id = p_id;
end $$;

-- Yes or No to a job Sparky suggested.
create or replace function public.chat_answer_suggestion(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg chat_messages%rowtype;
begin
  select * into v_msg from chat_messages where id = p_id and deleted_at is null;
  if not found or not is_chat_member(v_msg.channel_id) or v_msg.tag_suggested_project_id is null then return; end if;
  if p_accept then
    update chat_messages set project_id = tag_suggested_project_id, tagged_by = 'ai', tagged_by_profile_id = (select auth.uid()), tag_suggested_project_id = null
    where id = p_id;
  else
    update chat_messages set tag_rejected_project_ids = tag_rejected_project_ids || tag_suggested_project_id, tag_suggested_project_id = null
    where id = p_id;
  end if;
end $$;

-- Unread chat count for the nav badge.
create or replace function public.chat_unread_total()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(unread), 0)::int from chat_my_channels() where not muted and archived_at is null
$$;

revoke execute on function public.trg_chat_message_before_insert() from public, anon, authenticated;
revoke execute on function public.trg_chat_message_after_insert() from public, anon, authenticated;
grant execute on function public.trg_chat_message_before_insert() to service_role;
grant execute on function public.trg_chat_message_after_insert() to service_role;

revoke execute on function public.is_chat_member(uuid) from public, anon;
revoke execute on function public.chat_can_access_path(text) from public, anon;
revoke execute on function public.chat_my_channels() from public, anon;
revoke execute on function public.chat_open_dm(uuid[]) from public, anon;
revoke execute on function public.chat_create_channel(text, text, boolean, uuid[]) from public, anon;
revoke execute on function public.chat_update_channel(uuid, text, text, boolean, boolean, uuid[]) from public, anon;
revoke execute on function public.chat_mark_read(uuid) from public, anon;
revoke execute on function public.chat_set_muted(uuid, boolean) from public, anon;
revoke execute on function public.chat_edit_message(uuid, text) from public, anon;
revoke execute on function public.chat_delete_message(uuid) from public, anon;
revoke execute on function public.chat_set_tag(uuid, uuid) from public, anon;
revoke execute on function public.chat_answer_suggestion(uuid, boolean) from public, anon;
revoke execute on function public.chat_unread_total() from public, anon;
grant execute on function public.is_chat_member(uuid) to authenticated, service_role;
grant execute on function public.chat_can_access_path(text) to authenticated, service_role;
grant execute on function public.chat_my_channels() to authenticated, service_role;
grant execute on function public.chat_open_dm(uuid[]) to authenticated, service_role;
grant execute on function public.chat_create_channel(text, text, boolean, uuid[]) to authenticated, service_role;
grant execute on function public.chat_update_channel(uuid, text, text, boolean, boolean, uuid[]) to authenticated, service_role;
grant execute on function public.chat_mark_read(uuid) to authenticated, service_role;
grant execute on function public.chat_set_muted(uuid, boolean) to authenticated, service_role;
grant execute on function public.chat_edit_message(uuid, text) to authenticated, service_role;
grant execute on function public.chat_delete_message(uuid) to authenticated, service_role;
grant execute on function public.chat_set_tag(uuid, uuid) to authenticated, service_role;
grant execute on function public.chat_answer_suggestion(uuid, boolean) to authenticated, service_role;
grant execute on function public.chat_unread_total() to authenticated, service_role;

-- ============================================================
-- Files: private bucket, folder per chat, only people in the chat
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat', 'chat', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "chat members read chat files" on storage.objects;
create policy "chat members read chat files" on storage.objects for select to authenticated
  using (bucket_id = 'chat' and (select chat_can_access_path(name)));
drop policy if exists "chat members upload chat files" on storage.objects;
create policy "chat members upload chat files" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat' and (select chat_can_access_path(name)));
drop policy if exists "chat uploader deletes own chat files" on storage.objects;
create policy "chat uploader deletes own chat files" on storage.objects for delete to authenticated
  using (bucket_id = 'chat' and owner_id = ((select auth.uid()))::text);

-- ============================================================
-- Starting channels, and instant delivery
-- ============================================================

insert into public.chat_channels (kind, name, description, slug, everyone, is_social) values
  ('channel', 'General', 'Work chat for the whole team', 'general', true, false),
  ('channel', 'Social', 'Off-topic chat. Sparky only reads this to spot work talk to tag to a job.', 'social', true, true)
on conflict (slug) do nothing;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
     ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end
$$;
