-- Item 73b (backlog item 73): AI tags on job pictures, so a picture can be found by what is in it
-- ("Sigenergy", "switchboard") and a quote can offer recent installs with the same gear.
--
-- project_photos gains:
--   tags              what the picture is found by: brands seen, what it shows, models read off a
--                     label, and the kind of picture (finished install, before, damage...). Lower
--                     case. Written by the picture tagger; a person can add or take one off.
--   tags_text         the tags as one line of text, kept by the database, so a search can match
--                     part of a word ("sigen") or a tag of two words ("solar panels")
--   ai_caption        one plain line on what the picture shows (the person's own caption stays in caption)
--   ok_for_proposals  a finished install with nobody and nothing identifying in it: fine to show
--                     another customer as an example. The tagger suggests it; a person can change it.
--   tagged_at         when the tagger finished with it (null: not read yet, or to be tried again)
--   tag_note          why it could not be read, when it could not
--   tag_tries         failed reads so far (after 3 the tagger gives up and sets tagged_at)
--   tag_claimed_at    set while a run is reading it, so two runs never read the same picture
--
-- company_settings.photo_tagging_on: off until the owner has looked over a dry run (Settings >
-- Company Details > Picture tags) and switched it on. While it is off nothing is tagged or saved:
-- a new AI worker starts read only.
--
-- No policy change: staff can already read and update project_photos (rename), which is what
-- adding a tag by hand needs. The tagger writes with the service role.

-- array_to_string is not marked immutable (it is for any array type), so a generated column
-- cannot call it directly; for a text array its result never changes, which this wrapper states.
create or replace function public.photo_tags_text(p_tags text[])
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select array_to_string(p_tags, ' ');
$$;

alter table public.project_photos
  add column if not exists tags text[] not null default '{}',
  add column if not exists ai_caption text,
  add column if not exists ok_for_proposals boolean not null default false,
  add column if not exists tagged_at timestamptz,
  add column if not exists tag_note text,
  add column if not exists tag_tries smallint not null default 0,
  add column if not exists tag_claimed_at timestamptz;

alter table public.project_photos
  add column if not exists tags_text text generated always as (public.photo_tags_text(tags)) stored;

alter table public.company_settings
  add column if not exists photo_tagging_on boolean not null default false;

-- search by tag, and the tagger's "what is still to read" list
create index if not exists project_photos_tags_idx on public.project_photos using gin (tags);
create index if not exists project_photos_untagged_idx on public.project_photos (created_at) where tagged_at is null;
