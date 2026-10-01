-- A single, dedicated cover-page background photo (Settings > Logo and
-- branding), used by the auto-generated PDF's title page instead of
-- randomly picking a different real portfolio photo per document. One
-- company-controlled image, reused identically across every proposal -
-- consistent, and its size/quality is set once rather than inherited
-- from whatever a given job photo happens to be.
alter table company_settings add column if not exists cover_photo_url text;
