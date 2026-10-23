-- Notifications in three places (backlog item 32, 23 Oct 2026).
--   bell      things to do or know now: counted on the bell, pushed to the phone
--   messages  chats and emails: counted on the Messages icon (the Chat icon in the top bar),
--             read when the chat or the Inbox thread is opened
--   (no row)  ops manager work (emailed bills, price lists, statements, stock running low):
--             it lives on the Ops page "Needs me" card and in the 5am digest instead
-- Also: new shared inbox emails now tell Finance as well as Admin and Sales (never Staff),
-- and a one-off tidy marks every existing chat and email row read.

alter table public.notifications add column if not exists channel text not null default 'bell';
alter table public.notifications add constraint notifications_channel_check check (channel in ('bell', 'messages'));

create or replace function public.notification_channel(p_kind text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_kind in ('supplier_bill', 'price_list', 'statement', 'stock_low') then null
    when p_kind like 'chat%' or p_kind = 'email' then 'messages'
    else 'bell' end
$$;
revoke execute on function public.notification_channel(text) from public, anon;
grant execute on function public.notification_channel(text) to authenticated, service_role;

create or replace function public.create_notification(p_user uuid, p_kind text, p_title text, p_body text, p_link text, p_actor uuid, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channel text := notification_channel(p_kind);
begin
  if v_channel is null then return; end if; -- ops manager work: Ops page and digest, no row
  if p_user is null or p_user = p_actor then return; end if;
  if not exists (select 1 from profiles where id = p_user and active) then return; end if;
  if (select notification_prefs ->> p_kind from profiles where id = p_user) = 'false' then return; end if;
  insert into notifications (user_id, kind, channel, title, body, link, actor_id, dedupe_key)
  values (p_user, p_kind, v_channel, left(p_title, 200), left(p_body, 300), p_link, p_actor, p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
end $$;
revoke execute on function public.create_notification(uuid, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_notification(uuid, text, text, text, text, uuid, text) to service_role;

-- New shared inbox mail: the person handling the conversation, otherwise Admin, Finance and Sales.
create or replace function public.trg_notify_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_kind text; v_assigned uuid; v_subject text;
begin
  if new.direction <> 'inbound' then return new; end if;
  if new.sent_at is not null and new.sent_at < now() - interval '1 day' then return new; end if;
  if exists (select 1 from email_threads where id = new.thread_id and is_supplier_bill) then return new; end if;
  select m.kind, t.assigned_to into v_kind, v_assigned from email_threads t join mailboxes m on m.id = t.mailbox_id where t.id = new.thread_id;
  v_subject := coalesce(nullif(new.subject, ''), '(no subject)');
  if v_assigned is not null then
    perform create_notification(v_assigned, 'email', 'Reply on a conversation you are handling: ' || v_subject, 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html?thread=' || new.thread_id, null, 'email:' || new.id);
    return new;
  end if;
  if v_kind is distinct from 'shared' then return new; end if;
  for r in select id from profiles where active and role in ('admin', 'finance', 'sales') loop
    perform create_notification(r.id, 'email', 'New email: ' || v_subject, 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html?thread=' || new.thread_id, null, 'email:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
revoke execute on function public.trg_notify_email() from public, anon, authenticated;
grant execute on function public.trg_notify_email() to service_role;

-- Existing rows: ops manager kinds go (they are on the Ops page), chats and emails move to
-- Messages and start read (one-off tidy agreed with the owner).
delete from public.notifications where notification_channel(kind) is null;
update public.notifications set channel = 'messages' where notification_channel(kind) = 'messages';
update public.notifications set read_at = now() where channel = 'messages' and read_at is null;

create index if not exists notifications_user_channel_unread_idx on public.notifications (user_id, channel) where read_at is null;
