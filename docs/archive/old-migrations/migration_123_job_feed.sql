-- Company feed per job: a post can now belong to a job or quote
-- (feed_posts.project_id), with a choice of whether it also shows on the Home
-- feed (show_on_home) - posts made on Home itself have no project and always
-- show there. People can be tagged in a post (feed_mentions); a tag shows up
-- as a notification on that person's Home page until they open the post.
alter table feed_posts add column if not exists project_id uuid references projects(id) on delete cascade;
alter table feed_posts add column if not exists show_on_home boolean not null default true;
create index if not exists feed_posts_project_idx on feed_posts (project_id, created_at desc);

create table if not exists feed_mentions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references feed_posts(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (post_id, profile_id)
);
create index if not exists feed_mentions_unseen_idx on feed_mentions (profile_id) where seen_at is null;

alter table feed_mentions enable row level security;
drop policy if exists "Everyone can read mentions" on feed_mentions;
create policy "Everyone can read mentions" on feed_mentions for select to authenticated using (true);
drop policy if exists "Post author can tag people" on feed_mentions;
create policy "Post author can tag people" on feed_mentions for insert to authenticated
  with check (exists (select 1 from feed_posts p where p.id = post_id and p.author_id = auth.uid()));
drop policy if exists "Tagged person can mark seen" on feed_mentions;
create policy "Tagged person can mark seen" on feed_mentions for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
drop policy if exists "Post author can untag" on feed_mentions;
create policy "Post author can untag" on feed_mentions for delete to authenticated
  using (exists (select 1 from feed_posts p where p.id = post_id and p.author_id = auth.uid()));
