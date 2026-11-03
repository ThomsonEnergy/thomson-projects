-- Backlog item 40 (3 Nov 2026): Delete on the Emailed bills page. A deleted emailed bill keeps its
-- row with status 'deleted' (the intake searches the invoice@ label for the last 30 days and would
-- bring the email back if the row were removed); the stored file is removed by the server.
-- One check constraint change, no policy changes.

alter table public.supplier_bill_inbox drop constraint if exists supplier_bill_inbox_status_check;
alter table public.supplier_bill_inbox add constraint supplier_bill_inbox_status_check
  check (status in ('pending', 'processing', 'to_check', 'saved', 'duplicate', 'not_a_bill', 'failed', 'deleted'));
