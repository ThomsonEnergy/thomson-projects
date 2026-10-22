-- Backlog item 30 (22 Oct 2026): post site photos to the feed with a message and tagged people.
-- A feed post can carry site photos (project_photos) from its own job. Tags and the "also show on
-- the Home page" tick are the feed's existing feed_mentions and feed_posts.show_on_home, so the
-- tagged person's notification comes from the existing notify_mention trigger.

create table if not exists public.feed_post_photos (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts(id) on delete cascade,
  photo_id uuid not null references public.project_photos(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (post_id, photo_id)
);
-- The unique index leads with post_id, so it covers the post_id FK.
create index if not exists feed_post_photos_photo_id_idx on public.feed_post_photos (photo_id);

alter table public.feed_post_photos enable row level security;

drop policy if exists "Everyone can read feed post photos" on public.feed_post_photos;
create policy "Everyone can read feed post photos" on public.feed_post_photos
  for select to authenticated
  using (true);

-- Only the post's author attaches photos, and only photos from the post's own job
-- (a Home-only post has no job, so it takes none).
drop policy if exists "Post author adds photos from the same job" on public.feed_post_photos;
create policy "Post author adds photos from the same job" on public.feed_post_photos
  for insert to authenticated
  with check (exists (
    select 1 from public.feed_posts p
    join public.project_photos ph on ph.id = feed_post_photos.photo_id and ph.project_id = p.project_id
    where p.id = feed_post_photos.post_id and p.author_id = (select auth.uid())
  ));

drop policy if exists "Post author or admin removes photos" on public.feed_post_photos;
create policy "Post author or admin removes photos" on public.feed_post_photos
  for delete to authenticated
  using (
    exists (select 1 from public.feed_posts p where p.id = feed_post_photos.post_id and p.author_id = (select auth.uid()))
    or (select public.is_admin())
  );

-- One call makes the post, its tags and its photos, all or nothing. Security invoker: the
-- feed_posts, feed_mentions and feed_post_photos policies above check the caller.
create or replace function public.create_feed_post(
  p_project_id uuid,
  p_message text,
  p_show_on_home boolean,
  p_tagged uuid[] default '{}',
  p_photo_ids uuid[] default '{}'
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_post uuid;
  v_message text := coalesce(btrim(p_message), '');
  v_photos uuid[] := coalesce(p_photo_ids, '{}');
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if v_message = '' and cardinality(v_photos) = 0 then raise exception 'Write a message or add a photo'; end if;
  if cardinality(v_photos) > 0 and p_project_id is null then raise exception 'Photos can only be posted on a job feed'; end if;

  insert into feed_posts (author_id, message, project_id, show_on_home)
  values (v_me, v_message, p_project_id, case when p_project_id is null then true else coalesce(p_show_on_home, false) end)
  returning id into v_post;

  insert into feed_mentions (post_id, profile_id)
  select distinct v_post, t from unnest(coalesce(p_tagged, '{}')) t where t is not null;

  insert into feed_post_photos (post_id, photo_id, sort_order)
  select v_post, ph, min(ord)::int from unnest(v_photos) with ordinality as u(ph, ord) where ph is not null group by ph;

  return v_post;
end $$;

revoke execute on function public.create_feed_post(uuid, text, boolean, uuid[], uuid[]) from public, anon;
grant execute on function public.create_feed_post(uuid, text, boolean, uuid[], uuid[]) to authenticated;
