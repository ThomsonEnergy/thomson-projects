-- Quote in steps with STC and BSTC credits at quote level (docs/IDEAS_BACKLOG.md item 27).
-- 1. The credits move from the stage to the quote: STC (solar) and BSTC (battery) each with a
--    count, price and total, and an optional stage to claim each with (blank: the last stage).
--    Existing stage credits are copied up so live quotes and jobs do not change.
-- 2. BSTC kept apart from STC through invoice claims, invoices and credit notes (Formbay approves
--    and pays them separately); the balance functions include both.
-- 3. Site visit decision on the quote (step 2).

alter table public.projects add column if not exists stc_quantity numeric;
alter table public.projects add column if not exists stc_system_kw numeric;
alter table public.projects add column if not exists stc_zone_rating numeric default 1.382 not null;
alter table public.projects add column if not exists stc_install_year integer;
alter table public.projects add column if not exists stc_price_per_certificate numeric;
alter table public.projects add column if not exists stc_total numeric(12,2) default 0 not null;
alter table public.projects add column if not exists bstc_quantity numeric;
alter table public.projects add column if not exists bstc_price_per_certificate numeric;
alter table public.projects add column if not exists bstc_total numeric(12,2) default 0 not null;
alter table public.projects add column if not exists bstc_not_claimed boolean default false not null;
alter table public.projects add column if not exists stc_cost_centre_id uuid references public.cost_centres(id) on delete set null;
alter table public.projects add column if not exists bstc_cost_centre_id uuid references public.cost_centres(id) on delete set null;
create index if not exists projects_stc_cost_centre_id_idx on public.projects (stc_cost_centre_id);
create index if not exists projects_bstc_cost_centre_id_idx on public.projects (bstc_cost_centre_id);
alter table public.projects add column if not exists site_visit_decision text;
alter table public.projects add column if not exists site_visit_reason text;
alter table public.projects add constraint projects_site_visit_decision_check check (site_visit_decision is null or site_visit_decision in ('needed', 'not_needed'));

alter table public.invoice_claims add column if not exists bstc_amount numeric(12,2) default 0 not null;
alter table public.invoices add column if not exists bstc_amount numeric(12,2) default 0 not null;
alter table public.credit_note_claims add column if not exists bstc_amount numeric(12,2) default 0 not null;

comment on column public.projects.stc_total is 'Solar STC credit on the quote (ex GST), count x price. Was per stage before item 27.';
comment on column public.projects.bstc_total is 'Battery BSTC credit on the quote (ex GST), count x price.';
comment on column public.projects.stc_cost_centre_id is 'Stage the STC credit is claimed with; blank means the last stage.';
comment on column public.projects.bstc_cost_centre_id is 'Stage the BSTC credit is claimed with; blank means the last stage.';
comment on column public.projects.bstc_not_claimed is 'Battery quote with no BSTC on purpose (ready-to-send check passes without a BSTC count).';
comment on column public.invoice_claims.bstc_amount is 'Battery BSTC credit applied on this claim, kept apart from stc_amount (Formbay pays them separately).';

-- Existing stage credits move up to the quote (sum of the stages; count, size, zone, year and
-- price from the first stage that has a credit; the stage to claim with is the last stage that
-- carried a credit). Quotes and jobs alike.
update public.projects p
set stc_total = s.total,
    stc_quantity = s.qty,
    stc_system_kw = f.stc_system_kw,
    stc_zone_rating = coalesce(f.stc_zone_rating, 1.382),
    stc_install_year = f.stc_install_year,
    stc_price_per_certificate = f.stc_price_per_certificate,
    stc_cost_centre_id = l.id
from (
  select project_id, sum(stc_total) as total, nullif(sum(stc_quantity), 0) as qty
  from public.cost_centres
  where stc_total > 0
  group by project_id
) s
join lateral (
  select c.stc_system_kw, c.stc_zone_rating, c.stc_install_year, c.stc_price_per_certificate
  from public.cost_centres c
  where c.project_id = s.project_id and c.stc_total > 0
  order by c.sort_order
  limit 1
) f on true
join lateral (
  select c.id
  from public.cost_centres c
  where c.project_id = s.project_id and c.stc_total > 0
  order by c.sort_order desc
  limit 1
) l on true
where p.id = s.project_id;

-- Balance due: labour and materials plus GST, less the STC and BSTC credits (GST on the credits
-- for a company client, stc_credit_inc_gst), less credit notes.
create or replace function public.get_invoice_balance_due(p_invoice_id uuid)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  inv record;
  credited record;
begin
  select labour_amount, material_amount, stc_amount, bstc_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) + coalesce(sum(cnc.bstc_amount), 0) as stc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  return calculate_balance_due(
    inv.labour_amount - credited.labour,
    inv.material_amount - credited.material,
    inv.stc_amount + inv.bstc_amount - credited.stc,
    invoice_client_type(p_invoice_id)
  );
end;
$function$;

revoke execute on function public.get_invoice_balance_due(uuid) from public, anon;
grant execute on function public.get_invoice_balance_due(uuid) to authenticated;

-- The client quote page reads the quote-level credits.
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
        'accepted_signed_by_name', 'accepted_signature_data_url', 'declined_at', 'valid_until', 'expired', 'show_investment_breakdown',
        'stc_quantity', 'stc_total', 'bstc_quantity', 'bstc_total'])
    ),
    'client_type', coalesce((select cl.client_type from clients cl where cl.id = p.client_id), 'individual'),
    'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
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

-- The client invoice page shows the BSTC credit on its own line.
CREATE OR REPLACE FUNCTION public.get_invoice_by_token_v3(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  select to_jsonb(cs) - 'id' into v_company from company_settings cs where id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_office_address', (select c.address from clients c where c.id = p.client_id),
      'client_email', p.client_email,
      'proposal_template', p.proposal_template
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_office_address', c.address, 'client_email', c.email)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'stc_amount', ic.stc_amount,
      'bstc_amount', ic.bstc_amount,
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
        ) x
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb),
      'invoice_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', ili.kind, 'description', ili.description, 'quantity', ili.quantity,
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
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'bstc_amount', v_invoice.bstc_amount,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb),
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
  end if;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice) || jsonb_build_object(
      'balance_due', v_balance,
      'client_type', v_client_type,
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
$function$;

revoke execute on function public.get_quote_by_token(text) from public;
grant execute on function public.get_quote_by_token(text) to anon, authenticated;
revoke execute on function public.get_invoice_by_token_v3(uuid) from public;
grant execute on function public.get_invoice_by_token_v3(uuid) to anon, authenticated;
