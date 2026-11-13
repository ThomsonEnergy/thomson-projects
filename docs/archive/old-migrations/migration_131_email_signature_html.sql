-- Rich HTML email signature for the shared inbox. The signature itself is
-- generated (netlify/functions/_shared/build-email-signature.js) from data
-- that already exists - the sender's name, job title, mobile and photo
-- from profiles, and the company logo, address, website and licences from
-- company_settings - so changing a logo or licence number updates every
-- staff signature at once. These are the only new inputs it needs:
--   profiles.email_signature          reused as the per-person qualifications
--                                     line (e.g. "Nominated Supervisor (NSW) |
--                                     QBP & QTP (QLD)"); existing column.
--   profiles.email_signature_include_photo   whether to show their photo.
--   company_settings.social_*         links for the badges at the bottom.

alter table profiles add column if not exists email_signature_include_photo boolean not null default true;

-- profiles uses explicit column-level grants (see migrations 079/107): a
-- new column doesn't inherit them. migration_114's email_signature only
-- ever got INSERT/UPDATE, so reading it back from My Profile failed -
-- which made the whole My Profile select return nothing. Grant SELECT on
-- both, and UPDATE on the new one so people can set it on themselves.
grant select (email_signature, email_signature_include_photo) on profiles to authenticated;
grant insert (email_signature_include_photo), update (email_signature_include_photo) on profiles to authenticated;

alter table company_settings add column if not exists social_facebook text;
alter table company_settings add column if not exists social_instagram text;
alter table company_settings add column if not exists social_linkedin text;
