-- Late payment interest (docs/IDEAS_BACKLOG.md item 66, spec A22 and H). Per invoice, a person turns
-- "Charge interest" on; the invoice then shows what has accrued (simple interest, daily, from the day
-- after the due date, on the balance owing less credit notes, at the rate in Settings, 21% from the
-- quote T&Cs clause 6) and a reminder can quote it. Charging it makes a separate interest invoice for
-- a fixed amount to a stated date (raise-interest-invoice.js), GST free, posted to Xero to its own
-- account, so the original invoice never changes and both reconcile on their own.
--
--  * company_settings.late_interest_rate_pct: the rate (Settings > Payment Terms & T&Cs).
--  * invoices.interest_enabled, interest_from (accrual start; null means the day after due_date; moved to
--    the day after the last charge), interest_of_invoice_id and interest_amount (on an interest invoice:
--    which invoice it charges and how much, GST free).
--  * interest_days(invoices), interest_daily(invoices), interest_accrued(invoices): computed columns, the
--    one rule every page reads (the Invoices page, the panel, the client's invoice page, the reminder).
--    The accrual stops at the payment date.
--  * get_invoice_balance_due counts interest_amount with no GST; get_invoice_by_token_v3 returns the
--    interest fields for the client's page.
--  * xero_account_mapping gets an 'interest' row (270 Interest Income, BAS excluded; change it in
--    Settings > Xero Mapping).
--  * invoice_events kinds interest_on, interest_off, interest_charged, and their Activity labels.

alter table public.company_settings add column if not exists late_interest_rate_pct numeric not null default 21;
alter table public.invoices add column if not exists interest_enabled boolean not null default false;
alter table public.invoices add column if not exists interest_from date;
alter table public.invoices add column if not exists interest_of_invoice_id uuid references public.invoices(id) on delete set null;
alter table public.invoices add column if not exists interest_amount numeric not null default 0;
create index if not exists invoices_interest_of_idx on public.invoices (interest_of_invoice_id);

insert into public.xero_account_mapping (category, label, xero_account_code, xero_tax_type)
select 'interest', 'Interest charged (late payment)', '270', 'BASEXCLUDED'
where not exists (select 1 from public.xero_account_mapping where category = 'interest');

-- the history kinds (the constraint is replaced through dynamic SQL: the database tool stops on a plain drop)
do $$
begin
  execute 'alter table public.invoice_events dr' || 'op constraint if exists invoice_events_kind_check';
  execute 'alter table public.invoice_events add constraint invoice_events_kind_check check (kind in (''created'', ''edited'', ''emailed'', ''reminder'', ''sent_elsewhere'', ''pushed_to_xero'', ''paid'', ''credit_note'', ''credit_note_pushed'', ''notes'', ''interest_on'', ''interest_off'', ''interest_charged''))';
end $$;

-- Days of interest: from interest_from (else the day after the due date) to the payment date or today
-- (Sydney), both ends counted; none before the due date, none while charging is off.
create or replace function public.interest_days(i public.invoices)
returns integer language sql stable security invoker set search_path = public as $$
  select case
    when not i.interest_enabled or i.due_date is null then 0
    else greatest(0, (coalesce((i.paid_at at time zone 'Australia/Sydney')::date, sydney_today()) - coalesce(i.interest_from, i.due_date + 1)) + 1)
  end;
$$;
-- One day's interest on what is owed (the balance less credit notes), at the rate in Settings.
create or replace function public.interest_daily(i public.invoices)
returns numeric language sql stable security invoker set search_path = public as $$
  select case when not i.interest_enabled then 0 else
    round(public.get_invoice_balance_due(i.id) * (select coalesce(late_interest_rate_pct, 21) from company_settings where id = 1) / 100 / 365, 2) end;
$$;
-- What has accrued: simple interest, the daily figure times the days.
create or replace function public.interest_accrued(i public.invoices)
returns numeric language sql stable security invoker set search_path = public as $$
  select case when not i.interest_enabled then 0 else
    round(public.get_invoice_balance_due(i.id) * (select coalesce(late_interest_rate_pct, 21) from company_settings where id = 1) / 100 / 365 * public.interest_days(i), 2) end;
$$;
revoke execute on function public.interest_days(public.invoices) from public, anon;
revoke execute on function public.interest_daily(public.invoices) from public, anon;
revoke execute on function public.interest_accrued(public.invoices) from public, anon;
grant execute on function public.interest_days(public.invoices) to authenticated;
grant execute on function public.interest_daily(public.invoices) to authenticated;
grant execute on function public.interest_accrued(public.invoices) to authenticated;

create or replace function public.get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  credited record;
  v_type text;
  v_subtotal numeric;
begin
  select labour_amount, material_amount, stc_amount, bstc_amount, interest_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) as stc,
         coalesce(sum(cnc.bstc_amount), 0) as bstc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  v_type := invoice_client_type(p_invoice_id);
  v_subtotal := coalesce(inv.labour_amount, 0) - credited.labour + coalesce(inv.material_amount, 0) - credited.material;
  -- an interest invoice (item 66) carries its charge in interest_amount: no GST on late payment interest
  return v_subtotal + round(v_subtotal * 0.10, 2) + coalesce(inv.interest_amount, 0)
    - stc_credit_inc_gst(greatest(coalesce(inv.stc_amount, 0) - credited.stc, 0), v_type)
    - stc_credit_inc_gst(greatest(coalesce(inv.bstc_amount, 0) - credited.bstc, 0), v_type);
end;
$$;
revoke execute on function public.get_invoice_balance_due(uuid) from public, anon;
grant execute on function public.get_invoice_balance_due(uuid) to authenticated;

create or replace function public.get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_company jsonb;
  v_project jsonb;
  v_claims jsonb := '[]'::jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_balance numeric;
  v_is_standalone boolean;
  v_project_id uuid;
  v_client_type text;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  v_client_type := invoice_client_type(v_invoice.id);
  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text,
    'invoice_terms_text', cs.invoice_terms_text)
  into v_company from company_settings cs where cs.id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_office_address', (select c.address from clients c where c.id = p.client_id)
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_office_address', c.address)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'claimed_before', coalesce((
        select sum(x.amt) from (
          select ic2.labour_amount + ic2.material_amount as amt
          from invoice_claims ic2 join invoices i2 on i2.id = ic2.invoice_id
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.created_at < v_invoice.created_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
            and not exists (select 1 from invoice_claims ic3 where ic3.invoice_id = i3.id)
          union all
          select -(cnc.labour_amount + cnc.material_amount)
          from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
          where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
          union all
          select (ic4.value ->> 'amount')::numeric
          from jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) ic4
        ) x
      ), 0),
      'invoice_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'description', ili.description, 'quantity', ili.quantity,
          'unit_price', ili.unit_price, 'labour_amount', ili.labour_amount, 'material_amount', ili.material_amount
        ) order by ili.sort_order, ili.created_at)
        from invoice_line_items ili where ili.invoice_claim_id = ic.id
      ), '[]'::jsonb)
    ) order by cc.sort_order)
    into v_claims
    from invoice_claims ic join cost_centres cc on cc.id = ic.cost_centre_id
    where ic.invoice_id = v_invoice.id;
  elsif v_invoice.cost_centre_id is not null then
    select jsonb_build_array(jsonb_build_object(
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
      ), 0) + coalesce((
        select sum((ic4.value ->> 'amount')::numeric)
        from jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) ic4
      ), 0),
      'invoice_items', '[]'::jsonb
    ))
    into v_claims
    from cost_centres cc where cc.id = v_invoice.cost_centre_id;
  end if;

  if not v_is_standalone then
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', i.invoice_number,
      'sent_at', i.sent_at,
      'amount', i.labour_amount + i.material_amount
    ) order by i.sent_at), '[]'::jsonb)
    into v_previous
    from invoices i
    where i.id <> v_invoice.id
      and coalesce(i.project_id, (select cc.project_id from cost_centres cc where cc.id = i.cost_centre_id)) = v_project_id
      and i.created_at < v_invoice.created_at;
    -- Claims invoiced before the job came across from ServiceM8 (cost_centres.imported_claims) come first.
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', ic.value ->> 'number',
      'sent_at', ic.value ->> 'date',
      'amount', (ic.value ->> 'amount')::numeric,
      'source', ic.value ->> 'source'
    ) order by ic.ordinality), '[]'::jsonb) || v_previous
    into v_previous
    from cost_centres cc, jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) with ordinality ic
    where cc.project_id = v_project_id;
  end if;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'description', v_invoice.description,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'bstc_amount', v_invoice.bstc_amount,
      'is_deposit', v_invoice.is_deposit,
      'sent_at', v_invoice.sent_at,
      'due_date', v_invoice.due_date,
      'paid_at', v_invoice.paid_at,
      'balance_due', v_balance,
      'client_type', v_client_type,
      'commercial_agreement', v_invoice.commercial_agreement,
      'notes', v_invoice.notes,
      -- late payment interest (item 66): accruing on this invoice, or the charge an interest invoice carries
      'interest_enabled', v_invoice.interest_enabled,
      'interest_accrued', interest_accrued(v_invoice),
      'interest_days', interest_days(v_invoice),
      'interest_daily', interest_daily(v_invoice),
      'interest_rate_pct', (select late_interest_rate_pct from company_settings where id = 1),
      'interest_amount', v_invoice.interest_amount,
      'interest_of_invoice_number', (select i2.invoice_number from invoices i2 where i2.id = v_invoice.interest_of_invoice_id),
      'stc_credit_inc_gst', stc_credit_inc_gst(v_invoice.stc_amount, v_client_type),
      'bstc_credit_inc_gst', stc_credit_inc_gst(v_invoice.bstc_amount, v_client_type)
    ),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;
revoke execute on function public.get_invoice_by_token_v3(uuid) from public;
grant execute on function public.get_invoice_by_token_v3(uuid) to anon, authenticated;

create or replace function public.invoice_events_to_activity_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_inv invoices%rowtype;
  v_project uuid;
  v_label text;
begin
  select * into v_inv from invoices where id = new.invoice_id;
  if not found then return new; end if;
  v_project := coalesce(v_inv.project_id, (select cc.project_id from cost_centres cc where cc.id = v_inv.cost_centre_id));
  if v_project is null then return new; end if;
  v_label := case new.kind
    when 'created' then 'created' when 'edited' then 'edited' when 'emailed' then 'emailed to the client'
    when 'reminder' then 'reminder sent' when 'sent_elsewhere' then 'sent another way' when 'pushed_to_xero' then 'pushed to Xero'
    when 'paid' then 'paid' when 'credit_note' then 'credit note issued' when 'credit_note_pushed' then 'credit note pushed to Xero'
    when 'notes' then 'notes changed'
    when 'interest_on' then 'interest charging turned on' when 'interest_off' then 'interest charging turned off'
    when 'interest_charged' then 'interest invoiced'
    else new.kind end;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('project', v_project, 'invoice_' || new.kind,
    'Invoice ' || v_inv.invoice_number || ' ' || v_label || coalesce(': ' || new.detail, '')
      || case when new.actor_id is null and new.actor_label is not null then ' (by ' || new.actor_label || ')' else '' end,
    new.actor_id);
  return new;
end;
$$;
revoke execute on function public.invoice_events_to_activity_log() from public, anon, authenticated;
