-- Notifications: one list per person (the bell in the top bar) plus phone
-- push. Rows are created by database triggers when something happens that
-- concerns a person - so it covers every way the thing can happen (the app,
-- Netlify functions, the Gmail sync) - and by the send-notifications function
-- for timed reminders. The same function pushes new rows to each person's
-- subscribed phones/browsers.
--   kinds: tag, comment, task_assigned, task_reminder, followup_done, scheduled, email
alter table profiles add column if not exists notification_prefs jsonb not null default '{}';
alter table job_tasks add column if not exists remind_notified_at timestamptz;

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  actor_id uuid references profiles(id) on delete set null,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_unpushed_idx on notifications (created_at) where pushed_at is null;
create unique index if not exists notifications_dedupe_idx on notifications (user_id, dedupe_key) where dedupe_key is not null;

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

alter table notifications enable row level security;
drop policy if exists "Users read own notifications" on notifications;
create policy "Users read own notifications" on notifications for select using (user_id = auth.uid());
drop policy if exists "Users update own notifications" on notifications;
create policy "Users update own notifications" on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Users delete own notifications" on notifications;
create policy "Users delete own notifications" on notifications for delete using (user_id = auth.uid());

alter table push_subscriptions enable row level security;
drop policy if exists "Users manage own push subscriptions" on push_subscriptions;
create policy "Users manage own push subscriptions" on push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- creating a notification (never callable from the browser) ----------
create or replace function create_notification(p_user uuid, p_kind text, p_title text, p_body text, p_link text, p_actor uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = p_actor then return; end if;
  if not exists (select 1 from profiles where id = p_user and active) then return; end if;
  if (select notification_prefs ->> p_kind from profiles where id = p_user) = 'false' then return; end if;
  insert into notifications (user_id, kind, title, body, link, actor_id, dedupe_key)
  values (p_user, p_kind, left(p_title, 200), left(p_body, 300), p_link, p_actor, p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
end $$;
revoke all on function create_notification(uuid, text, text, text, text, uuid, text) from public, anon, authenticated;

create or replace function notif_job_label(p_project uuid) returns text language sql stable security definer set search_path = public as $$
  select case when job_number is not null then 'J' || job_number || ' - ' || name
              when quote_number is not null then 'Q' || quote_number || ' - ' || name
              else name end
  from projects where id = p_project
$$;
revoke all on function notif_job_label(uuid) from public, anon, authenticated;

-- Every trigger function ends with an exception handler: if building a
-- notification ever fails, the save that caused it still goes through.

-- ---------- someone tagged in a post or comment ----------
create or replace function trg_notify_mention() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_post feed_posts%rowtype; v_comment feed_comments%rowtype;
  v_actor uuid; v_msg text; v_name text; v_job text; v_link text;
begin
  select * into v_post from feed_posts where id = new.post_id;
  if new.comment_id is not null then
    select * into v_comment from feed_comments where id = new.comment_id;
    v_actor := v_comment.author_id; v_msg := v_comment.message;
  else
    v_actor := v_post.author_id; v_msg := v_post.message;
  end if;
  select full_name into v_name from profiles where id = v_actor;
  v_job := notif_job_label(v_post.project_id);
  v_link := case when v_post.project_id is not null then '/project.html?id=' || v_post.project_id || '&tab=feed' else '/home.html' end;
  perform create_notification(new.profile_id, 'tag',
    coalesce(v_name, 'Someone') || ' tagged you ' || case when new.comment_id is not null then 'in a comment' else 'in a post' end || case when v_job is not null then ' on ' || v_job else '' end,
    v_msg, v_link, v_actor, 'mention:' || new.id);
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
drop trigger if exists notify_mention on feed_mentions;
create trigger notify_mention after insert on feed_mentions for each row execute function trg_notify_mention();

-- ---------- a comment on your post ----------
create or replace function trg_notify_comment() returns trigger language plpgsql security definer set search_path = public as $$
declare v_post feed_posts%rowtype; v_name text; v_job text;
begin
  select * into v_post from feed_posts where id = new.post_id;
  select full_name into v_name from profiles where id = new.author_id;
  v_job := notif_job_label(v_post.project_id);
  perform create_notification(v_post.author_id, 'comment',
    coalesce(v_name, 'Someone') || ' commented on your post' || case when v_job is not null then ' on ' || v_job else '' end,
    new.message,
    case when v_post.project_id is not null then '/project.html?id=' || v_post.project_id || '&tab=feed' else '/home.html' end,
    new.author_id, 'comment:' || new.id);
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
drop trigger if exists notify_comment on feed_comments;
create trigger notify_comment after insert on feed_comments for each row execute function trg_notify_comment();

-- ---------- a task given to you / a meeting follow-up finished ----------
create or replace function trg_notify_task() returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_job text; v_link text; v_creator uuid;
begin
  if new.assigned_to_user_id is not null and not new.completed
     and (tg_op = 'INSERT' or old.assigned_to_user_id is distinct from new.assigned_to_user_id) then
    select full_name into v_name from profiles where id = auth.uid();
    v_job := notif_job_label(new.project_id);
    v_link := case when new.meeting_id is not null then '/meetings.html?id=' || new.meeting_id
                   when new.project_id is not null then '/project.html?id=' || new.project_id
                   else '/tasks.html' end;
    perform create_notification(new.assigned_to_user_id, 'task_assigned',
      coalesce(v_name, 'Someone') || ' gave you a task',
      new.description || case when v_job is not null then ' (' || v_job || ')' else '' end || case when new.due_date is not null then ' - due ' || to_char(new.due_date, 'Dy DD Mon') else '' end,
      v_link, auth.uid(), 'task:' || new.id || ':' || new.assigned_to_user_id);
  end if;

  if tg_op = 'UPDATE' and new.completed and not old.completed and new.meeting_id is not null then
    select created_by into v_creator from meetings where id = new.meeting_id;
    select full_name into v_name from profiles where id = coalesce(new.completed_by, auth.uid());
    perform create_notification(v_creator, 'followup_done',
      coalesce(v_name, 'Someone') || ' finished a meeting follow-up',
      new.description || ' - confirm it was followed up',
      '/meetings.html?id=' || new.meeting_id, coalesce(new.completed_by, auth.uid()), 'fu:' || new.id);
  end if;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
drop trigger if exists notify_task on job_tasks;
create trigger notify_task after insert or update on job_tasks for each row execute function trg_notify_task();

-- ---------- booked onto the schedule ----------
create or replace function trg_notify_schedule() returns trigger language plpgsql security definer set search_path = public as $$
declare v_label text;
begin
  if tg_op = 'UPDATE' and old.staff_id = new.staff_id then return new; end if;
  v_label := coalesce(notif_job_label(new.project_id), nullif(new.note, ''), case new.block_type when 'training' then 'Training' when 'office' then 'Office / admin' when 'site_inspection' then 'Site inspection' else 'Booking' end);
  perform create_notification(new.staff_id, 'scheduled',
    'You are booked: ' || v_label,
    to_char(new.assignment_date, 'Dy DD Mon') || ', ' || substr(new.start_time::text, 1, 5) || ' to ' || substr(new.end_time::text, 1, 5),
    '/my-day.html', auth.uid(), 'sched:' || new.id || ':' || new.staff_id);
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
drop trigger if exists notify_schedule on schedule_assignments;
create trigger notify_schedule after insert or update of staff_id on schedule_assignments for each row execute function trg_notify_schedule();

-- ---------- new email in the shared inbox (admin + sales) ----------
create or replace function trg_notify_email() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.direction <> 'inbound' then return new; end if;
  if new.sent_at is not null and new.sent_at < now() - interval '1 day' then return new; end if; -- old mail pulled in by a first sync
  for r in select id from profiles where active and role in ('admin', 'sales') loop
    perform create_notification(r.id, 'email', 'New email: ' || coalesce(nullif(new.subject, ''), '(no subject)'), 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html', null, 'email:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
drop trigger if exists notify_email on emails;
create trigger notify_email after insert on emails for each row execute function trg_notify_email();

revoke all on function trg_notify_mention(), trg_notify_comment(), trg_notify_task(), trg_notify_schedule(), trg_notify_email() from public, anon, authenticated;

-- live badge updates in the top bar
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;
