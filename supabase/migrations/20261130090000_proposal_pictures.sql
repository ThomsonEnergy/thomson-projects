-- Item 73a (backlog item 73): the pictures a proposal uses, set in Settings > Company Details >
-- Proposal pictures.
--
--  * company_settings.proposal_cover_photos: the title page picture for each proposal type, as
--    { "solar": "<url>", "battery": "<url>", ... } keyed by projects.proposal_template. A type with
--    no entry keeps the built-in picture.
--  * company_settings.about_photo_url: the one picture beside "About Thomson Energy" on every
--    proposal. Blank keeps the built-in pictures.
--  * get_public_company_settings() also returns the two, so the client's proposal page can show
--    them. Same checks as before (migration 20261124131544): it returns a fixed list of fields.
--
-- The picture uploaded under the old Settings > Cover page photo box (company_settings.cover_photo_url)
-- never reached a proposal. It starts as the title picture for every type but Battery, which keeps
-- its built-in battery picture, so the front page changes the day this ships. Each can be changed or
-- taken off in Settings.

alter table public.company_settings
  add column if not exists proposal_cover_photos jsonb not null default '{}'::jsonb,
  add column if not exists about_photo_url text;

update public.company_settings
set proposal_cover_photos = jsonb_build_object(
  'new_build', cover_photo_url, 'solar', cover_photo_url, 'quick_estimate', cover_photo_url,
  'renovation', cover_photo_url, 'service_work', cover_photo_url)
where id = 1
  and coalesce(cover_photo_url, '') <> ''
  and proposal_cover_photos = '{}'::jsonb;

create or replace function public.get_public_company_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'company_name', company_name, 'abn', abn, 'address', address, 'phone', phone, 'website', website,
    'licenses', licenses, 'logo_url', logo_url, 'tagline', tagline, 'rates_reviewed_on', rates_reviewed_on,
    'proposal_cover_photos', proposal_cover_photos, 'about_photo_url', about_photo_url)
  from company_settings where id = 1;
$$;
revoke execute on function public.get_public_company_settings() from public, anon, authenticated;
grant execute on function public.get_public_company_settings() to anon, authenticated;
