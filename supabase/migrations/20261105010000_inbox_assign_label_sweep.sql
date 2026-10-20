-- Inbox: who is handling a conversation, label sweeps and agent-made labels
-- (docs/PROJECT_SPEC.md A18, docs/DECISIONS.md 19 Oct 2026).
--
-- 1. email_threads.assigned_to: the staff member handling a conversation ("I've got
--    this" or assigned by someone else), so two people never chase the same client.
--    Sending a reply from TEops claims an unclaimed conversation for the sender.
-- 2. email_labels.sweep_requested_at: a new label (or a changed description) asks the
--    email agent to go back over the last 60 days of that inbox and apply the label
--    where it fits. The mailbox worker does it and sets sweep_done_at.
-- 3. email_labels.by_ai: the label was made by the agent (mailboxes.auto_labels on).
-- 4. The "New email" notification goes to the person handling the conversation only,
--    when there is one; otherwise to admin and sales as before.

alter table public.email_threads
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists assigned_by uuid references public.profiles(id) on delete set null,
  add column if not exists assigned_at timestamptz;

create index if not exists email_threads_assigned_to_idx on public.email_threads (assigned_to);
create index if not exists email_threads_assigned_by_idx on public.email_threads (assigned_by);

alter table public.email_labels
  add column if not exists by_ai boolean not null default false,
  add column if not exists sweep_requested_at timestamptz,
  add column if not exists sweep_done_at timestamptz;

create index if not exists email_labels_sweep_idx on public.email_labels (mailbox_id) where sweep_requested_at is not null;

alter table public.mailboxes
  add column if not exists auto_labels boolean not null default false;

-- Conversations a label sweep should look at: the inbox's last p_days of mail that does
-- not carry the label yet, with the newest inbound message's sender and a short snippet.
-- Only the server (service role) calls it from the mailbox worker.
create or replace function public.email_label_sweep_candidates(p_label_id uuid, p_days integer default 60, p_limit integer default 1500)
returns table (thread_id uuid, gmail_thread_id text, subject text, last_message_at timestamptz, from_address text, snippet text)
language sql
stable
set search_path = public
as $$
  select t.id, t.gmail_thread_id, t.subject, t.last_message_at, e.from_address,
         left(regexp_replace(coalesce(e.body_text, ''), '\s+', ' ', 'g'), 400)
  from email_labels l
  join email_threads t on t.mailbox_id = l.mailbox_id
  left join lateral (
    select from_address, body_text from emails
    where emails.thread_id = t.id and emails.direction = 'inbound'
    order by sent_at desc limit 1
  ) e on true
  where l.id = p_label_id
    and t.is_supplier_bill = false
    and t.last_message_at > now() - make_interval(days => p_days)
    and not exists (select 1 from email_thread_labels x where x.thread_id = t.id and x.label_id = l.id)
  order by t.last_message_at desc
  limit p_limit
$$;

revoke execute on function public.email_label_sweep_candidates(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.email_label_sweep_candidates(uuid, integer, integer) to service_role;

-- "New email" pushes: to the person handling the conversation when there is one (with
-- a link straight to it), otherwise sales@ to admin and sales as before. Personal
-- mailboxes get none here: the email agent tells the owner about Priority mail itself.
CREATE OR REPLACE FUNCTION public.trg_notify_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  for r in select id from profiles where active and role in ('admin', 'sales') loop
    perform create_notification(r.id, 'email', 'New email: ' || v_subject, 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html?thread=' || new.thread_id, null, 'email:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $function$
;

revoke execute on function public.trg_notify_email() from public, anon, authenticated;
grant execute on function public.trg_notify_email() to service_role;
