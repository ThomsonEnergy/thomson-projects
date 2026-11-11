-- Item 73b (backlog item 73): AI tags on job pictures, so a picture can be found by what is in it
-- ("Sigenergy", "switchboard") and a quote can offer recent installs with the same gear.
--
-- project_photos gains:
--   tags              what the picture is found by: brands seen, what it shows, models read off a
--                     label, and the kind of picture (finished install, before, damage...). Lower
--                     case. Written by the picture tagger; a person can add or take one off.
--   ai_caption        one plain line on what the picture shows (the person's own caption stays in caption)
--   ok_for_proposals  a finished install with nobody and nothing identifying in it: fine to show
--                     another customer as an example
--   tagged_at         when the tagger read it (null: not read yet)
--   tag_note          why it could not be read, when it could not
--
-- company_settings.photo_tagging_on: off until the owner has looked over a dry run (Settings >
-- Company Details > Picture tags) and switched it on. While it is off nothing is tagged or saved:
-- a new AI worker starts read only.
--
-- No policy change: staff can already read and update project_photos (rename), which is what
-- adding a tag by hand needs. The tagger writes with the service role.

alter table public.project_photos
  add column if not exists tags text[] not null default '{}',
  add column if not exists ai_caption text,
  add column if not exists ok_for_proposals boolean not null default false,
  add column if not exists tagged_at timestamptz,
  add column if not exists tag_note text;

alter table public.company_settings
  add column if not exists photo_tagging_on boolean not null default false;

-- search by tag, and the tagger's "what is still to read" list
create index if not exists project_photos_tags_idx on public.project_photos using gin (tags);
create index if not exists project_photos_untagged_idx on public.project_photos (created_at) where tagged_at is null;
