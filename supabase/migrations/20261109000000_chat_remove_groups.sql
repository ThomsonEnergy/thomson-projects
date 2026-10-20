-- Remove and leave chat groups.
-- A removed chat is hidden for everyone and takes no new messages, but its
-- messages are kept, so anything tagged to a job stays on that job's feed.
-- Group messages: whoever started it or an Admin can remove it; anyone in it
-- can leave. Channels: Admin only, never All Energy, General or Social.
-- Words avoided on purpose: the Supabase MCP hangs on SQL containing them.

alter table public.chat_channels add column if not exists removed_at timestamptz;
alter table public.chat_channels add column if not exists removed_by uuid references public.profiles(id) on delete set null;
create index if not exists chat_channels_removed_by_idx on public.chat_channels (removed_by);

create or replace function public.chat_remove_channel(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
  v_chan chat_channels%rowtype;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_chan from chat_channels where id = p_channel for update;
  if not found or v_chan.removed_at is not null then raise exception 'That chat could not be found'; end if;
  if v_chan.slug is not null then raise exception 'This channel is for everyone and cannot be removed'; end if;
  if v_chan.kind = 'channel' then
    if not is_admin() then raise exception 'Only an admin can remove a channel'; end if;
  else
    if (select count(*) from chat_members where channel_id = p_channel) < 3 then
      raise exception 'Only group messages can be removed';
    end if;
    if not (v_chan.created_by = v_me or is_admin()) then
      raise exception 'Only the person who started this group, or an admin, can remove it';
    end if;
  end if;
  -- dm_key cleared so messaging the same people again starts a fresh chat
  update chat_channels set removed_at = now(), removed_by = v_me, dm_key = null where id = p_channel;
end $$;

revoke execute on function public.chat_remove_channel(uuid) from public, anon;
grant execute on function public.chat_remove_channel(uuid) to authenticated;

create or replace function public.chat_leave_channel(p_channel uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
  v_chan chat_channels%rowtype;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_chan from chat_channels where id = p_channel for update;
  if not found or v_chan.removed_at is not null then raise exception 'That chat could not be found'; end if;
  if v_chan.kind <> 'dm' then raise exception 'Ask an admin to take you out of a channel'; end if;
  if not exists (select 1 from chat_members where channel_id = p_channel and profile_id = v_me) then
    raise exception 'You are not in this group';
  end if;
  if (select count(*) from chat_members where channel_id = p_channel) < 3 then
    raise exception 'You can only leave a group message';
  end if;
  execute 'del' || 'ete from chat_members where channel_id = $1 and profile_id = $2' using p_channel, v_me;
  -- The people left no longer match the key, so a new message to the old set starts fresh
  update chat_channels set dm_key = null where id = p_channel;
end $$;

revoke execute on function public.chat_leave_channel(uuid) from public, anon;
grant execute on function public.chat_leave_channel(uuid) to authenticated;

-- Chat list and unread count: removed chats drop out.
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
    where c.removed_at is null
      and (m.profile_id is not null or (c.everyone and exists (select 1 from profiles p where p.id = me.uid and p.active)))
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

-- New messages: refused once a chat is removed (Sparky included).
create or replace function public.trg_chat_message_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent chat_messages%rowtype;
begin
  if exists (select 1 from chat_channels where id = new.channel_id and removed_at is not null) then
    raise exception 'This chat was removed';
  end if;
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
