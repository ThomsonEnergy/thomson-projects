-- Security fixes from the site review (docs/BUG_REVIEW.md, S items).

-- S1: a profile someone creates for themselves can only be a staff profile (an admin
-- sets the role). Sign-ups should also be off in Supabase Auth.
alter policy "Users can insert own profile" on public.profiles
  with check ((select auth.uid()) = id and role = 'staff');

-- S5: functions that should never run for someone who is not logged in. Only the
-- server (service role) draws numbers; the old accept_quote is unused (accept-quote.js).
revoke execute on function public.get_next_number_serverside(text) from public, anon, authenticated;
revoke execute on function public.accept_quote(text) from public, anon, authenticated;
revoke execute on function public.get_nonbillable_cost_by_category(date, date) from public, anon;
revoke execute on function public.get_supplier_financial_summary(uuid) from public, anon;
revoke execute on function public.get_stage_actual_hours(uuid) from public, anon;
revoke execute on function public.get_stage_actual_labour_cost(uuid) from public, anon;
revoke execute on function public.get_stage_actual_material_cost(uuid) from public, anon;
grant execute on function public.get_nonbillable_cost_by_category(date, date) to authenticated;
grant execute on function public.get_supplier_financial_summary(uuid) to authenticated;
grant execute on function public.get_stage_actual_hours(uuid) to authenticated;
grant execute on function public.get_stage_actual_labour_cost(uuid) to authenticated;
grant execute on function public.get_stage_actual_material_cost(uuid) to authenticated;

-- S6: PO prices, stock counts and material costs only for logged-in people (the supplier's
-- PO page reads through get_po_by_token, the client pages through their own functions).
alter policy "Everyone can view materials" on public.materials to authenticated;
alter policy "Everyone can view stock locations" on public.material_stock_by_location to authenticated;
alter policy "Everyone can manage stock locations" on public.material_stock_by_location to authenticated;
alter policy "Everyone can view PO line items" on public.purchase_order_line_items to authenticated;
alter policy "Everyone can add PO line items" on public.purchase_order_line_items to authenticated;

-- S9: the client's quote link only gets the fields the quote page shows (no internal notes,
-- installer summary, who made it, Xero / ServiceM8 ids and so on).
create or replace function public.get_quote_by_token(p_token text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  result json;
begin
  select json_build_object(
    'project', (
      select json_object_agg(e.key, e.value)
      from jsonb_each(to_jsonb(p)) e
      where e.key = any (array['id', 'name', 'client_name', 'client_address', 'status', 'quote_token', 'quote_number', 'job_number',
        'terms_text', 'cover_photos', 'reference_photos', 'created_at', 'sent_at', 'sow_text', 'proposal_subtitle', 'deposit_percent',
        'pylon_link', 'pylon_data', 'proposal_template', 'estimate_disclaimer_text', 'approved_at', 'approval_method', 'approval_note',
        'accepted_signed_by_name', 'accepted_signature_data_url', 'declined_at', 'valid_until', 'expired'])
    ),
    'client_type', coalesce((select cl.client_type from clients cl where cl.id = p.client_id), 'individual'),
    'prepared_by', (select pr.full_name from profiles pr where pr.id = p.created_by),
    'cost_centres', (
      select coalesce(json_agg(
        json_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'is_variation', (c.variation_entry_id is not null),
          'variation_reason', ve.reason,
          'photo_groups', (
            select coalesce(json_agg(
              json_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::json)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            select coalesce(json_agg(
              json_build_object('description', li.description, 'amount', li.amount, 'quantity', li.quantity, 'item_type', li.item_type)
              order by li.sort_order
            ), '[]'::json)
            from (
              select cli.description as description,
                (case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                      else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                 end) as amount,
                cli.quantity as quantity,
                cli.item_type as item_type,
                cli.sort_order as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is null

              union all

              select max(cli.prebuild_client_description) as description,
                sum(case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                         else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                    end) as amount,
                (array_agg(cli.quantity / nullif(cli.prebuild_base_quantity, 0) order by cli.sort_order))[1] as quantity,
                null::text as item_type,
                min(cli.sort_order) as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is not null
              group by cli.prebuild_group_id
            ) li
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c
      left join job_variation_entries ve on ve.id = c.variation_entry_id
      where c.project_id = p.id
        and (c.variation_entry_id is null or (ve.variation_type = 'fixed' and ve.approval_status = 'approved'))
    ),
    'payment_milestones', (
      select coalesce(json_agg(
        json_build_object('label', m.label, 'percent', m.percent)
        order by m.sort_order
      ), '[]'::json)
      from payment_milestones m where m.project_id = p.id
    ),
    'schedule_of_rates', (
      case when p.proposal_template = 'quick_estimate' then (
        select coalesce(json_agg(
          json_build_object('name', t.name, 'sell_rate', t.sell_rate)
          order by t.sort_order
        ), '[]'::json)
        from billable_rate_tiers t
      ) else null end
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$function$;

-- S10: staff can ask for leave and change or cancel it while it is pending, but not approve
-- it; Admin and Finance decide it.
alter policy "Staff can manage own leave requests" on public.leave_requests
  using ((select auth.uid()) = staff_id and status = 'pending')
  with check ((select auth.uid()) = staff_id and status = 'pending');
drop policy if exists "Staff can view own leave requests" on public.leave_requests;
create policy "Staff can view own leave requests" on public.leave_requests for select
  using ((select auth.uid()) = staff_id);
alter policy "Admins can decide leave requests" on public.leave_requests
  using (is_admin() or is_finance_role());

-- S11: reopening a closed PO, approving it for payment or locking it only through the PO
-- steps (po_set_closed and friends), or by Admin / Finance.
create or replace function public.guard_po_status_fields() returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  if coalesce(current_setting('teops.po_step', true), '') = 'on' or (select auth.uid()) is null
     or is_admin() or is_finance_role() then
    return new;
  end if;
  -- closing (anyone may, po_set_closed): closed, locked and approved for payment together
  if old.closed_at is null and new.closed_at is not null and new.locked and new.approved_for_payment then
    return new;
  end if;
  if new.closed_at is distinct from old.closed_at or new.approved_for_payment is distinct from old.approved_for_payment
     or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
     or new.locked is distinct from old.locked then
    raise exception 'Use Close / Reopen on the PO for that (Admin or Finance to reopen).';
  end if;
  return new;
end $$;
drop trigger if exists guard_po_status_fields on public.purchase_orders;
create trigger guard_po_status_fields before update on public.purchase_orders
  for each row execute function public.guard_po_status_fields();

-- S13: emails in someone's own mailbox can only be changed by them (or anyone for the shared
-- sales@ mailbox). A thread tagged to a job stays readable by everyone, not editable.
create or replace function public.can_edit_email_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from email_threads t
    where t.id = p_thread_id and t.mailbox_id in (select my_mailbox_ids())
  )
$$;
revoke execute on function public.can_edit_email_thread(uuid) from public, anon;
grant execute on function public.can_edit_email_thread(uuid) to authenticated;

alter policy "emails insert" on public.emails with check (can_edit_email_thread(thread_id));
alter policy "emails update" on public.emails using (can_edit_email_thread(thread_id)) with check (can_edit_email_thread(thread_id));
alter policy "emails delete" on public.emails using (can_edit_email_thread(thread_id));
alter policy "email_job_links delete" on public.email_job_links
  using (can_edit_email_thread(thread_id) or created_by = (select auth.uid()));
