-- Migration 019 — Company feed (posts, comments, likes) for the new home page
-- Run this in Supabase: SQL Editor > New query > paste > Run.

create table if not exists feed_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id),
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists feed_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references feed_posts(id) on delete cascade,
  author_id uuid not null references profiles(id),
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists feed_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references feed_posts(id) on delete cascade,
  author_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (post_id, author_id)
);

alter table feed_posts enable row level security;
alter table feed_comments enable row level security;
alter table feed_likes enable row level security;

-- A company noticeboard, not pricing data - every logged-in role can
-- read and participate equally. Only the author (or an admin) can edit
-- or delete their own post/comment.

drop policy if exists "Everyone can read posts" on feed_posts;
create policy "Everyone can read posts" on feed_posts for select using (true);
drop policy if exists "Everyone can create posts" on feed_posts;
create policy "Everyone can create posts" on feed_posts for insert with check (auth.uid() = author_id);
drop policy if exists "Author or admin can update posts" on feed_posts;
create policy "Author or admin can update posts" on feed_posts for update using (auth.uid() = author_id or is_admin());
drop policy if exists "Author or admin can delete posts" on feed_posts;
create policy "Author or admin can delete posts" on feed_posts for delete using (auth.uid() = author_id or is_admin());

drop policy if exists "Everyone can read comments" on feed_comments;
create policy "Everyone can read comments" on feed_comments for select using (true);
drop policy if exists "Everyone can create comments" on feed_comments;
create policy "Everyone can create comments" on feed_comments for insert with check (auth.uid() = author_id);
drop policy if exists "Author or admin can delete comments" on feed_comments;
create policy "Author or admin can delete comments" on feed_comments for delete using (auth.uid() = author_id or is_admin());

drop policy if exists "Everyone can read likes" on feed_likes;
create policy "Everyone can read likes" on feed_likes for select using (true);
drop policy if exists "Everyone can like" on feed_likes;
create policy "Everyone can like" on feed_likes for insert with check (auth.uid() = author_id);
drop policy if exists "Everyone can unlike their own like" on feed_likes;
create policy "Everyone can unlike their own like" on feed_likes for delete using (auth.uid() = author_id);
