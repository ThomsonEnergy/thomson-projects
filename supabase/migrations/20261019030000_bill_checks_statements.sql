-- Bill checks against POs, supplier queries and statement reconciliation (spec A11c).
--
-- Every supplier bill is checked line by line against its PO by _shared/bill-check.js
-- (check_status + check_issues). A bill with problems can be queried with the supplier
-- (email from invoice@, query_* columns); only bills that pass (or whose query is resolved)
-- are approved for payment automatically when the PO is fully received.
-- Supplier statements (emailed or uploaded) are read and reconciled both ways by
-- _shared/statement-intake.js: missing bills, amounts that differ, invoices listed twice,
-- bills entered twice, bills not on the statement, balance differences.

alter table public.supplier_bills
  add column if not exists check_status text,
  add column if not exists check_issues jsonb not null default '[]'::jsonb,
  add column if not exists checked_at timestamptz,
  add column if not exists query_sent_at timestamptz,
  add column if not exists query_gmail_thread_id text,
  add column if not exists query_reply_at timestamptz,
  add column if not exists resolved_note text,
  add column if not exists resolved_by uuid references public.profiles(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at timestamptz;

alter table public.supplier_bills drop constraint if exists supplier_bills_check_status_check;
alter table public.supplier_bills add constraint supplier_bills_check_status_check
  check (check_status is null or check_status in ('matches', 'problems', 'no_po', 'queried', 'resolved'));

create index if not exists supplier_bills_resolved_by_idx on public.supplier_bills (resolved_by);
create index if not exists supplier_bills_approved_by_idx on public.supplier_bills (approved_by);
create index if not exists supplier_bills_check_status_idx on public.supplier_bills (check_status);
create index if not exists supplier_bills_supplier_number_idx on public.supplier_bills (supplier_id, lower(bill_number));

alter table public.supplier_statements
  add column if not exists status text,
  add column if not exists lines jsonb not null default '[]'::jsonb,
  add column if not exists issues jsonb not null default '[]'::jsonb,
  add column if not exists our_unpaid numeric,
  add column if not exists email_id uuid references public.emails(id) on delete set null,
  add column if not exists gmail_message_id text,
  add column if not exists attachment_part_id text,
  add column if not exists file_name text,
  add column if not exists email_from text,
  add column if not exists supplier_name_read text,
  add column if not exists error text,
  add column if not exists attempts integer not null default 0,
  add column if not exists processed_at timestamptz,
  add column if not exists query_sent_at timestamptz,
  add column if not exists query_gmail_thread_id text,
  add column if not exists query_reply_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

alter table public.supplier_statements drop constraint if exists supplier_statements_status_check;
alter table public.supplier_statements add constraint supplier_statements_status_check
  check (status is null or status in ('pending', 'processing', 'reconciled', 'issues', 'reviewed', 'not_a_statement', 'failed'));

create unique index if not exists supplier_statements_attachment_key on public.supplier_statements (gmail_message_id, attachment_part_id) where gmail_message_id is not null;
create index if not exists supplier_statements_supplier_id_idx on public.supplier_statements (supplier_id);
create index if not exists supplier_statements_email_id_idx on public.supplier_statements (email_id);
create index if not exists supplier_statements_reviewed_by_idx on public.supplier_statements (reviewed_by);
create index if not exists supplier_statements_status_idx on public.supplier_statements (status, created_at desc);
