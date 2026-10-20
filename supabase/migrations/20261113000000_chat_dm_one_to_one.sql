-- Direct messages are one to one; group chats are channels.
-- Anyone active can make a channel for people they pick. Only an Admin can
-- make or switch on an Everyone channel. Whoever made a channel, or an
-- Admin, can rename it, change who is in it and archive it. The person who
-- made it always stays in it unless an Admin takes them out.
-- The member clean-up runs through execute because the Supabase MCP hangs on
-- SQL that contains that word.

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
  if coalesce(array_length(v_ids, 1), 0) < 2 then raise exception 'Pick a person to message'; end if;
  if array_length(v_ids, 1) > 2 then raise exception 'Messages are one to one. For a group, make a channel.'; end if;
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
  if v_me is null or not exists (select 1 from profiles where id = v_me and active) then raise exception 'Not logged in'; end if;
  if coalesce(p_everyone, false) and not is_admin() then raise exception 'Only an admin can make a channel for everyone'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the channel a name'; end if;
  if not coalesce(p_everyone, false)
     and not exists (select 1 from unnest(coalesce(p_member_ids, '{}')) x join profiles p on p.id = x where p.active and x <> v_me) then
    raise exception 'Pick at least one person for the channel';
  end if;
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

create or replace function public.chat_update_channel(p_channel uuid, p_name text, p_description text, p_archived boolean, p_everyone boolean, p_member_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := (select auth.uid());
  v_admin boolean := coalesce(is_admin(), false);
  v_chan chat_channels%rowtype;
  v_ids uuid[];
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_chan from chat_channels where id = p_channel and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if not (v_admin or (v_chan.slug is null and v_chan.created_by = v_me and exists (select 1 from profiles where id = v_me and active))) then
    raise exception 'Only the person who made this channel, or an admin, can change it';
  end if;
  if not v_admin and coalesce(p_everyone, false) and not v_chan.everyone then
    raise exception 'Only an admin can make a channel for everyone';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the channel a name'; end if;
  update chat_channels set
    name = trim(p_name),
    description = nullif(trim(coalesce(p_description, '')), ''),
    archived_at = case when coalesce(p_archived, false) and slug is null then coalesce(archived_at, now()) when not coalesce(p_archived, false) then null else archived_at end,
    everyone = case when slug is not null then true else coalesce(p_everyone, everyone) end
  where id = p_channel;
  if v_chan.slug is null and not coalesce(p_everyone, v_chan.everyone) and p_member_ids is not null then
    -- The maker keeps their place unless an admin takes them out
    v_ids := case when v_admin then p_member_ids else p_member_ids || v_me end;
    execute 'del' || 'ete from chat_members where channel_id = $1 and not (profile_id = any($2))' using p_channel, v_ids;
    insert into chat_members (channel_id, profile_id)
    select p_channel, x from unnest(v_ids) x where x in (select id from profiles where active)
    on conflict do nothing;
  end if;
end $$;

revoke execute on function public.chat_open_dm(uuid[]) from public, anon;
revoke execute on function public.chat_create_channel(text, text, boolean, uuid[]) from public, anon;
revoke execute on function public.chat_update_channel(uuid, text, text, boolean, boolean, uuid[]) from public, anon;
grant execute on function public.chat_open_dm(uuid[]) to authenticated, service_role;
grant execute on function public.chat_create_channel(text, text, boolean, uuid[]) to authenticated, service_role;
grant execute on function public.chat_update_channel(uuid, text, text, boolean, boolean, uuid[]) to authenticated, service_role;
