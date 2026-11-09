-- Quoted lines on a claim invoice (docs/IDEAS_BACKLOG.md item 67, spec A22). A claim against a quoted stage
-- printed the stage as one line; from now on every new claim invoice lists the stage's quoted lines (the same
-- lines and prices the quote page shows) by itself. Invoices raised before this keep the one line, so a PDF
-- already sent still matches its page; one tick on the invoice turns it on for an older invoice or off for one.
--
--  * invoices.show_quote_lines: false on every existing row, default true for new rows.
--  * cost_centre_quote_lines(cost_centre_id): the stage's quoted lines priced as the quote prices them
--    (labour at the quoted rate, materials at the stage markup, a prebuild as one line), server only.
--  * get_invoice_by_token_v3 returns show_quote_lines and, when it is on, quote_lines per stage.
--  * invoice_events kinds quote_lines_on and quote_lines_off, with their Activity labels.
-- Item 68 (interest in the client's totals and Pay online) needs no schema change: it reads the item 66 columns.

alter table public.invoices add column if not exists show_quote_lines boolean not null default false;
alter table public.invoices alter column show_quote_lines set default true;

do $$
begin
  execute 'alter table public.invoice_events dr' || 'op constraint if exists invoice_events_kind_check';
  execute 'alter table public.invoice_events add constraint invoice_events_kind_check check (kind in (''created'', ''edited'', ''emailed'', ''reminder'', ''sent_elsewhere'', ''pushed_to_xero'', ''paid'', ''credit_note'', ''credit_note_pushed'', ''notes'', ''interest_on'', ''interest_off'', ''interest_charged'', ''quote_lines_on'', ''quote_lines_off''))';
end $$;

-- The stage's quoted lines, priced the way get_quote_by_token prices them for the client's quote page.
create or replace function public.cost_centre_quote_lines(p_cost_centre_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'description', li.description, 'amount', round(li.amount, 2), 'quantity', li.quantity, 'item_type', li.item_type)
    order by li.sort_order), '[]'::jsonb)
  from (
    select cli.description as description,
      (case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
            else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0) end) as amount,
      cli.quantity as quantity, cli.item_type as item_type, cli.sort_order as sort_order
    from cost_centre_line_items cli join cost_centres c on c.id = cli.cost_centre_id
    where cli.cost_centre_id = p_cost_centre_id and cli.prebuild_group_id is null
    union all
    select max(cli.prebuild_client_description) as description,
      sum(case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
               else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0) end) as amount,
      (array_agg(cli.quantity / nullif(cli.prebuild_base_quantity, 0) order by cli.sort_order))[1] as quantity,
      null::text as item_type, min(cli.sort_order) as sort_order
    from cost_centre_line_items cli join cost_centres c on c.id = cli.cost_centre_id
    where cli.cost_centre_id = p_cost_centre_id and cli.prebuild_group_id is not null
    group by cli.prebuild_group_id
  ) li;
$$;
revoke execute on function public.cost_centre_quote_lines(uuid) from public, anon, authenticated;

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
    when 'quote_lines_on' then 'quoted lines shown' when 'quote_lines_off' then 'quoted lines hidden'
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
