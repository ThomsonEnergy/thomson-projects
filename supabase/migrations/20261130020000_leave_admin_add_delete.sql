-- Item 60 (owner, 8 Nov 2026): Finance and Admin add leave for any staff member and delete any leave.
--
--   1  Insert: Admin and Finance can add a request for anyone, waiting or already approved (decided by
--      themselves). The Xero columns stay empty: only the timesheet push sets them.
--   2  Delete: Admin and Finance can delete any request, whatever its status. Leave already in Xero
--      Payroll stays there; the page warns to delete it in Xero too.
-- Staff policies (own requests, pending only) are unchanged.

drop policy if exists "Admin and Finance can add leave for anyone" on public.leave_requests;
create policy "Admin and Finance can add leave for anyone" on public.leave_requests for insert to authenticated
  with check (
    ((select is_admin()) or (select is_finance_role()))
    and xero_leave_application_id is null and xero_pushed_at is null and xero_units is null
    and (
      (status = 'pending' and decided_by is null and decided_at is null)
      or (status = 'approved' and decided_by = (select auth.uid()) and decided_at is not null)
    )
  );

drop policy if exists "Admin and Finance can delete leave" on public.leave_requests;
create policy "Admin and Finance can delete leave" on public.leave_requests for delete to authenticated
  using ((select is_admin()) or (select is_finance_role()));
