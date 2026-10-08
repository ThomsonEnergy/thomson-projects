-- Names for the pages of a PDF in Documents (e.g. "Lighting plan", "Power
-- plan", "Cable paths"), shown as page tabs in the in-app PDF viewer. An
-- array of text, one entry per page, in page order; null = unnamed.
alter table project_documents add column if not exists page_names jsonb;
