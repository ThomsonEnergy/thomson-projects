-- Quotes and jobs become genuinely separate records, instead of one
-- project row that just gains a job_number in place.
--
-- A quote stays exactly as sent once approved (status becomes 'approved',
-- stamped with when/who/why) - it's now a frozen historical record,
-- permanently visible in the Quotes list. Approval (online by the client,
-- or manually by staff) creates a NEW project row - a full duplicate of
-- the quote's stages/pricing/details - which gets its own job number (via
-- the same trigger that already assigns one to a fresh Direct Job) and is
-- the one that actually gets invoiced, varied, and scheduled from here on.

alter table projects add column if not exists source_quote_id uuid references projects(id) on delete set null;
alter table projects add column if not exists approved_at timestamptz;
alter table projects add column if not exists approved_by uuid references profiles(id) on delete set null;
alter table projects add column if not exists approval_note text;

create index if not exists projects_source_quote_id_idx on projects (source_quote_id);
