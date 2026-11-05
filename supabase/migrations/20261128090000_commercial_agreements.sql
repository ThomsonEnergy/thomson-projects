-- Commercial agreements (docs/IDEAS_BACKLOG.md item 48, spec D1a). Builds on the charge rate levels
-- (migration 20261128070000): a level under 100% is now a commercial agreement, an efficiency
-- reduction off the Schedule of Rates that the client gets in writing and that can be withdrawn.
--
--  * company_settings.commercial_agreement_terms: the letter's wording (Settings > Billable Rates),
--    with [Client], [Percent] and [Date] filled in when the PDF is made.
--  * clients: agreement_token (the public agreement page, rates.html?agreement=...&token=...),
--    agreement_sent_at, agreement_withdrawn_at and reason, agreement_document_path (the last PDF).
--  * invoices.commercial_agreement: what the invoice's agreement line was made from
--    (name, percent_off, amount, sent_at), so the invoice page can print the note under the totals.
--  * get_commercial_agreement(client, token): the public agreement page's data (the client's name,
--    the percent off, the terms, the Schedule of Rates at Standard). Null when there is no agreement.
--  * client_withdraw_agreement(client, reason): pricing roles; the client and every quote or job of
--    theirs go back to Standard in one step, with an activity log line on each.
--  * get_schedule_of_rates and get_quote_by_token: the labour rates print at Standard (a level over
--    100% still scales them, as before) and the agreement comes back on its own ('agreement':
--    name, percent_off) for the box under the rates.
--  * get_invoice_by_token_v3: returns invoices.commercial_agreement.

alter table public.company_settings add column if not exists commercial_agreement_terms text;
update public.company_settings set commercial_agreement_terms = $terms$Thomson Energy Australia charges every client at the rates in our Schedule of Rates (attached). They are our standard rates for all work, large or small.

Working with [Client] takes less of our time than most jobs: regular work without a quote for each job, clear site instructions, and less phone, email and paperwork time per job. We pass that saving on. While this agreement is in place, labour on your do and charge work is invoiced at the Schedule of Rates less [Percent]%, shown as its own line on each invoice.

This is a goodwill arrangement between us, not a term of any quote or contract. Our Schedule of Rates remains the agreed rate for all work.

It depends on that efficiency continuing. We may end it at any time by written notice, and we will if the time a job takes us changes, for example invoices not paid in full by their due date, work regularly queried after the fact, or more quoting and administration per job. We review it each year.

The reduction on any invoice applies only when that invoice is paid in full by its due date. If it is not, the reduction is withdrawn for that invoice and the balance at the full Schedule of Rates is payable. When the agreement ends, the full Schedule of Rates applies to all work from that date. Invoices already paid are not changed.

The reduction applies to labour rates only. Materials, equipment, subcontractors, permits and fees are charged as quoted or invoiced.$terms$
  where id = 1 and commercial_agreement_terms is null;

alter table public.clients add column if not exists agreement_token uuid not null default gen_random_uuid();
alter table public.clients add column if not exists agreement_sent_at timestamptz;
alter table public.clients add column if not exists agreement_withdrawn_at timestamptz;
alter table public.clients add column if not exists agreement_withdrawn_reason text;
alter table public.clients add column if not exists agreement_document_path text;
create unique index if not exists clients_agreement_token_idx on public.clients (agreement_token);

alter table public.invoices add column if not exists commercial_agreement jsonb;

-- The public agreement page (rates.html?agreement=<client>&token=<agreement_token>), printed into the
-- PDF the client is sent. The random token is the check; nothing comes back without it, and nothing
-- comes back for a client whose level is not a reduction.
create or replace function public.get_commercial_agreement(p_client_id uuid, p_token uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'client_name', c.name,
    'client_address', c.address,
    'agreement_name', rc.name,
    'percent_off', round(100 - rc.percent, 1),
    'sent_at', c.agreement_sent_at,
    'terms', (select s.commercial_agreement_terms from company_settings s where s.id = 1),
    'reviewed_on', (select s.rates_reviewed_on from company_settings s where s.id = 1),
    'rates', (select coalesce(json_agg(json_build_object('name', t.name, 'sell_rate', t.sell_rate) order by t.sort_order), '[]'::json) from billable_rate_tiers t)
  )
  from clients c join rate_cards rc on rc.id = c.rate_card_id
  where c.id = p_client_id and p_token is not null and c.agreement_token = p_token and rc.percent < 100;
$$;
revoke execute on function public.get_commercial_agreement(uuid, uuid) from public;
grant execute on function public.get_commercial_agreement(uuid, uuid) to anon, authenticated;

-- Withdraw: the client and every quote or job of theirs back to Standard rates in one step. Lines
-- already saved and invoices already made are not touched; the next invoice has no agreement line.
create or replace function public.client_withdraw_agreement(p_client_id uuid, p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_client clients%rowtype;
  v_level text;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'no reason given');
  v_count integer := 0;
  r record;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can withdraw an agreement.'; end if;
  select * into v_client from clients where id = p_client_id;
  if not found then raise exception 'Client not found.'; end if;
  select name into v_level from rate_cards where id = v_client.rate_card_id;
  update clients set rate_card_id = null, agreement_withdrawn_at = now(), agreement_withdrawn_reason = nullif(trim(p_reason), '')
    where id = p_client_id;
  for r in update projects set rate_card_id = null where client_id = p_client_id and rate_card_id is not null returning id loop
    insert into activity_log (entity_type, entity_id, action, description, changed_by)
      values ('project', r.id, 'rate_card', format('Commercial agreement %s withdrawn (%s): Standard rates from now on', coalesce(v_level, ''), v_reason), auth.uid());
    v_count := v_count + 1;
  end loop;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
    values ('client', p_client_id, 'agreement_withdrawn', format('Commercial agreement %s withdrawn (%s); %s quote(s) and job(s) back to Standard rates', coalesce(v_level, ''), v_reason, v_count), auth.uid());
  return v_count;
end;
$$;
revoke all on function public.client_withdraw_agreement(uuid, text) from public, anon;
grant execute on function public.client_withdraw_agreement(uuid, text) to authenticated;

-- The Schedule of Rates: Standard rates, a level over 100% still scaling them, and the agreement on
-- its own when the job (proved by its quote token) has one.
create or replace function public.get_schedule_of_rates(p_project_id uuid default null, p_token text default null)
 returns json
 language sql
 stable security definer
 set search_path = public
as $function$
  with lvl as (
    select rc.name, rc.percent from projects p join rate_cards rc on rc.id = p.rate_card_id
    where p_project_id is not null and p_token is not null and p.id = p_project_id and p.quote_token = p_token
  )
  select json_build_object(
    'rates', (
      select coalesce(json_agg(json_build_object('name', t.name, 'sell_rate', round(t.sell_rate * greatest(coalesce((select percent from lvl), 100), 100) / 100, 2)) order by t.sort_order), '[]'::json)
      from billable_rate_tiers t
    ),
    'reviewed_on', (select s.rates_reviewed_on from company_settings s where s.id = 1),
    'rate_card_name', (select name from lvl where percent > 100),
    'agreement', (select json_build_object('name', name, 'percent_off', round(100 - percent, 1)) from lvl where percent < 100)
  );
$function$;
revoke execute on function public.get_schedule_of_rates(uuid, text) from public;
grant execute on function public.get_schedule_of_rates(uuid, text) to anon, authenticated;

-- get_quote_by_token (migration 20261128070000): the estimate's Schedule of Rates at Standard (a level
-- over 100% still scales it), the level's name only when it is over 100%, and the agreement on its own.
create or replace function public.get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'project', (
      (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(to_jsonb(p)) e
       where e.key = any (array['id', 'name', 'client_name', 'client_address', 'status', 'quote_token', 'quote_number', 'job_number',
         'terms_text', 'cover_photos', 'reference_photos', 'created_at', 'sent_at', 'sow_text', 'proposal_subtitle', 'deposit_percent',
         'pylon_link', 'proposal_template', 'estimate_disclaimer_text', 'approved_at', 'approval_method', 'approval_note',
         'accepted_signed_by_name', 'accepted_signature_data_url', 'declined_at', 'valid_until', 'expired', 'show_investment_breakdown',
         'stc_quantity', 'stc_total', 'bstc_quantity', 'bstc_total', 'stc_system_kw', 'stc_zone_rating', 'show_roi', 'battery_kwh']))
      || jsonb_build_object(
        'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
        'bill_reading', case when p.bill_reading is null then null else (
          select jsonb_object_agg(e.key, e.value) from jsonb_each(p.bill_reading) e
          where e.key = any (array['retailer', 'billing_days', 'bill_total', 'total_kwh', 'daily_average_kwh', 'peak_kwh', 'off_peak_kwh',
            'shoulder_kwh', 'controlled_load_kwh', 'solar_export_kwh', 'solar_soak_kwh', 'feed_in_c_per_kwh', 'usage_rate_c_per_kwh',
            'usage_rates', 'supply_charge_c_per_day', 'tariff_type', 'tou_hours', 'tou_other', 'tou_schedule'])) end,
        'pylon_data', case when p.pylon_data is null then null else jsonb_build_object(
          'module_types', p.pylon_data -> 'module_types',
          'inverter_types', p.pylon_data -> 'inverter_types',
          'storage_types', p.pylon_data -> 'storage_types',
          'summary', jsonb_build_object('dc_output_kw', p.pylon_data -> 'summary' -> 'dc_output_kw')) end,
        'roi_inputs', case when p.roi_inputs is null then null else (
          select jsonb_object_agg(e.key, e.value) from jsonb_each(p.roi_inputs) e
          where e.key = any (array['solar_price', 'battery_price', 'current', 'alt', 'plan_options'])) end
      )
    ),
    -- the pre-quote answers the savings estimate needs (never the whole set: it holds private notes)
    'roi_answers', jsonb_build_object(
      'existing_system', p.template_answers ->> 'existing_system',
      'existing_system_detail', p.template_answers ->> 'existing_system_detail',
      'existing_pv', p.template_answers ->> 'existing_pv',
      'with_battery', p.template_answers ->> 'with_battery',
      'battery_kwh_wanted', p.template_answers ->> 'battery_kwh_wanted',
      'export_limit', p.template_answers ->> 'export_limit'
    ),
    'client_type', coalesce((select cl.client_type from clients cl where cl.id = p.client_id), 'individual'),
    'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
    'prepared_by', (select pr.full_name from profiles pr where pr.id = p.created_by),
    'cost_centres', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'is_variation', (c.variation_entry_id is not null),
          'photo_groups', (
            select coalesce(jsonb_agg(
              jsonb_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::jsonb)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            select coalesce(jsonb_agg(
              jsonb_build_object('description', li.description, 'amount', li.amount, 'quantity', li.quantity, 'item_type', li.item_type)
              order by li.sort_order
            ), '[]'::jsonb)
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
      ), '[]'::jsonb)
      from cost_centres c
      left join job_variation_entries ve on ve.id = c.variation_entry_id
      where c.project_id = p.id
        and (c.variation_entry_id is null or (ve.variation_type = 'fixed' and ve.approval_status = 'approved'))
    ),
    'payment_milestones', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', m.label, 'percent', m.percent)
        order by m.sort_order
      ), '[]'::jsonb)
      from payment_milestones m where m.project_id = p.id
    ),
    'schedule_of_rates', (
      case when p.proposal_template = 'quick_estimate' then (
        select coalesce(jsonb_agg(
          jsonb_build_object('name', t.name, 'sell_rate', round(t.sell_rate * greatest(_rate_factor(p.id), 1), 2))
          order by t.sort_order
        ), '[]'::jsonb)
        from billable_rate_tiers t
      ) else null end
    ),
    'rate_card_name', (select rc.name from rate_cards rc where rc.id = p.rate_card_id and rc.percent > 100),
    'agreement', (select jsonb_build_object('name', rc.name, 'percent_off', round(100 - rc.percent, 1)) from rate_cards rc where rc.id = p.rate_card_id and rc.percent < 100)
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result::json;
end;
$$;

-- get_invoice_by_token_v3 (migration 20261128060000) plus the invoice's commercial agreement.
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
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text)
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
