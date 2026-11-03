-- Backlog item 40 (3 Nov 2026): Delete on the Emailed bills page. A deleted emailed bill keeps its
-- row with status 'deleted' (the intake searches the invoice@ label for the last 30 days and would
-- bring the email back if the row were removed); the stored file is removed by the server.
-- One check constraint change, no policy changes.

alter table public.supplier_bill_inbox drop constraint if exists supplier_bill_inbox_status_check;
alter table public.supplier_bill_inbox add constraint supplier_bill_inbox_status_check
  check (status in ('pending', 'processing', 'to_check', 'saved', 'duplicate', 'not_a_bill', 'failed', 'deleted'));

-- Already paid (Admin and Finance): a bill paid before the email came in. Approves the bill if it is
-- not approved yet and records it paid through supplier_bills_mark_paid, in one transaction, so a
-- failure leaves it neither approved nor paid (never approved-and-unpaid, which the pay run would pick up).
-- Called by supplier-bill-inbox.js with the service role only.
create or replace function public.supplier_bills_approve_and_mark_paid(p_bill_id uuid, p_paid_on date, p_reference text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill record;
begin
  -- the server calls this with no user; a logged-in caller must be Admin or Finance
  if auth.uid() is not null and not is_finance_role() then raise exception 'Only Admin or Finance can record payments.'; end if;
  if p_bill_id is null then raise exception 'Pick the bill first.'; end if;
  if p_paid_on is null then raise exception 'Enter the date paid.'; end if;
  if p_paid_on > sydney_today() then raise exception 'The paid date cannot be in the future.'; end if;

  select id, bill_number, paid, approved_for_payment, supplier_id into v_bill from supplier_bills where id = p_bill_id for update;
  if not found then raise exception 'That bill was not found. Reload the page.'; end if;
  if v_bill.paid then raise exception 'Bill % is already recorded as paid.', coalesce(v_bill.bill_number, '(no number)'); end if;
  if v_bill.supplier_id is null then raise exception 'No supplier on bill %. Pick the supplier first.', coalesce(v_bill.bill_number, '(no number)'); end if;

  -- paid already, so approval is a formality: approved by the person pressing the button, due the day it was paid
  if not v_bill.approved_for_payment then
    update supplier_bills set approved_for_payment = true, approved_by = p_user, approved_at = now(), pay_on = p_paid_on where id = p_bill_id;
  end if;
  return supplier_bills_mark_paid(array[p_bill_id], p_paid_on, p_reference, p_user);
end;
$$;
revoke execute on function public.supplier_bills_approve_and_mark_paid(uuid, date, text, uuid) from public, anon, authenticated;
grant execute on function public.supplier_bills_approve_and_mark_paid(uuid, date, text, uuid) to service_role;
