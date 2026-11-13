-- Tagging people in a feed COMMENT, not just a post. A mention row now
-- optionally points at the comment it came from (still carrying the post_id,
-- so "seen" handling and the job link work the same way). The old
-- one-tag-per-person-per-post rule becomes one per person per post-or-comment,
-- so someone tagged in a post can be tagged again in a later comment.
alter table feed_mentions add column if not exists comment_id uuid references feed_comments(id) on delete cascade;

alter table feed_mentions drop constraint if exists feed_mentions_post_id_profile_id_key;
create unique index if not exists feed_mentions_unique_idx
  on feed_mentions (post_id, profile_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop policy if exists "Post author can tag people" on feed_mentions;
drop policy if exists "Author can tag people" on feed_mentions;
create policy "Author can tag people" on feed_mentions for insert to authenticated
  with check (
    (comment_id is null and exists (select 1 from feed_posts p where p.id = post_id and p.author_id = auth.uid()))
    or (comment_id is not null and exists (select 1 from feed_comments c where c.id = comment_id and c.author_id = auth.uid()))
  );

drop policy if exists "Post author can untag" on feed_mentions;
drop policy if exists "Author can untag" on feed_mentions;
create policy "Author can untag" on feed_mentions for delete to authenticated
  using (
    (comment_id is null and exists (select 1 from feed_posts p where p.id = post_id and p.author_id = auth.uid()))
    or (comment_id is not null and exists (select 1 from feed_comments c where c.id = comment_id and c.author_id = auth.uid()))
  );
