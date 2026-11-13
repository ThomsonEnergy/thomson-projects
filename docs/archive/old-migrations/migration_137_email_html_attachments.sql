-- Shared inbox: keep the formatted (HTML) version of each email and a list of its
-- attachments. Attachment files are NOT stored: each entry is
--   { part_id, name, mime, size, cid, inline }
-- and the file is fetched from Gmail on demand (get-email-attachment function).
-- attachments = null means "not looked at yet" - the sync fills it in for mail it
-- pulled in before this existed (an email with no attachments gets []).
alter table emails add column if not exists body_html text;
alter table emails add column if not exists attachments jsonb;
create index if not exists emails_attachments_pending_idx on emails (sent_at desc) where attachments is null;
