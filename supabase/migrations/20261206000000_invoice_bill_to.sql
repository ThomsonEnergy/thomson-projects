-- Bill to on an invoice (owner, 16 Nov 2026): Edit details can bill an unpaid invoice to another
-- client (invoices.bill_to_client_id, the column warranty jobs already use; Xero and the STC credit
-- GST already follow it). Two functions follow it too:
--  * get_invoice_by_token_v3: the client's invoice page shows the bill-to client and their office
--    address in Bill to (before, it always showed the job's client). Otherwise unchanged from
--    20261130060000.
--  * get_client_statement_by_token: an invoice belongs to the statement of the client it is billed
--    to. Otherwise unchanged from 20261205000000.
-- Functions only, no data changes.

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

  -- Billed to another client (a warranty job billed to the manufacturer, or Edit details > Bill to):
  -- the Bill to block shows that client and their office address; the job's site stays as it is.
  if v_invoice.bill_to_client_id is not null then
    select coalesce(v_project, '{}'::jsonb) || jsonb_build_object('client_name', c.name, 'client_office_address', c.address)
    into v_project
    from clients c where c.id = v_invoice.bill_to_client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'quote_lines', case when v_invoice.show_quote_lines then cost_centre_quote_lines(cc.id) else '[]'::jsonb end,
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
      'quote_lines', case when v_invoice.show_quote_lines then cost_centre_quote_lines(cc.id) else '[]'::jsonb end,
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
      and i.interest_of_invoice_id is null -- an interest invoice (item 66) is not a claim on the job
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
      -- quoted lines on a claim invoice (item 67): the client page lists each stage's quoted lines when this is on
      'show_quote_lines', v_invoice.show_quote_lines,
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

create or replace function public.get_client_statement_by_token(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client clients%rowtype;
  v_company jsonb;
  v_rows jsonb;
begin
  if p_token is null then
    return null;
  end if;
  select * into v_client from clients where statement_token = p_token;
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text,
    'late_interest_rate_pct', cs.late_interest_rate_pct)
  into v_company from company_settings cs where cs.id = 1;

  select coalesce(jsonb_agg(x.r order by coalesce(x.due_date, (x.sent_at at time zone 'Australia/Sydney')::date) nulls last, x.sent_at, x.invoice_number), '[]'::jsonb)
  into v_rows
  from (
    select i.due_date, i.sent_at, i.invoice_number,
      jsonb_build_object(
        'invoice_number', i.invoice_number,
        'invoice_token', i.invoice_token,
        'sent_at', i.sent_at,
        'due_date', i.due_date,
        'is_deposit', i.is_deposit,
        'is_interest', i.interest_of_invoice_id is not null,
        'job_number', p.job_number,
        'job_name', p.name,
        'site', p.client_address,
        'balance', b.bal,
        'interest_accrued', case when i.interest_enabled then interest_accrued(i) else 0 end
      ) as r
    from invoices i
    left join cost_centres cc on cc.id = i.cost_centre_id
    left join projects p on p.id = coalesce(i.project_id, cc.project_id)
    cross join lateral (select get_invoice_balance_due(i.id) as bal) b
    where coalesce(i.bill_to_client_id, i.client_id, p.client_id) = v_client.id
      and i.paid_at is null
      and b.bal > 0.004
  ) x;

  return jsonb_build_object(
    'company', v_company,
    'client', jsonb_build_object('name', v_client.name, 'address', v_client.address),
    'as_at', sydney_today(),
    'invoices', v_rows
  );
end;
$$;
revoke execute on function public.get_client_statement_by_token(uuid) from public;
grant execute on function public.get_client_statement_by_token(uuid) to anon, authenticated;
