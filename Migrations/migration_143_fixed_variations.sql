-- Two kinds of variation (extra work outside the quote):
--
--   do_and_charge  the work is done first and billed for what it took. It gets its
--                  own cost centre the moment it is logged, so the team can pick it
--                  when clocking in on My Day like any stage; the clocked hours, any
--                  hours logged by hand and the Stock materials added are priced when
--                  it goes on an invoice (bill-variations.js).
--   fixed          a price is agreed before the work: the lines + reason are sent to
--                  the client as a link (quote.html?variation=<token>), they sign it
--                  there, and on approval it is added to the job as a stage (cost
--                  centre) at that price and shows on the quote.
--
-- Everything stays in job_variation_entries (migration 122/142).

alter table job_variation_entries add column if not exists variation_type text not null default 'do_and_charge';
alter table job_variation_entries drop constraint if exists job_variation_entries_variation_type_check;
alter table job_variation_entries add constraint job_variation_entries_variation_type_check check (variation_type in ('do_and_charge', 'fixed'));
alter table job_variation_entries add column if not exists variation_number int;
alter table job_variation_entries add column if not exists reason text;
-- fixed: [{ "description": text, "item_type": "labour" | "material", "amount": ex-GST dollars }]
alter table job_variation_entries add column if not exists fixed_lines jsonb not null default '[]'::jsonb;
alter table job_variation_entries add column if not exists approval_status text;
alter table job_variation_entries drop constraint if exists job_variation_entries_approval_status_check;
alter table job_variation_entries add constraint job_variation_entries_approval_status_check check (approval_status in ('draft', 'sent', 'approved', 'declined'));
alter table job_variation_entries add column if not exists variation_token uuid not null default gen_random_uuid();
alter table job_variation_entries add column if not exists sent_at timestamptz;
alter table job_variation_entries add column if not exists approved_at timestamptz;
alter table job_variation_entries add column if not exists signed_by_name text;
alter table job_variation_entries add column if not exists signature_data_url text;
create unique index if not exists job_variation_entries_token_uq on job_variation_entries (variation_token);

-- Number the existing ones per job (Variation 1, 2, ...).
update job_variation_entries e set variation_number = n.rn
from (select id, row_number() over (partition by project_id order by created_at) rn from job_variation_entries) n
where n.id = e.id and e.variation_number is null;

-- Existing open do-and-charge variations get their cost centre now, so they show up
-- as an option when clocking in.
do $$
declare
  e record;
  cc uuid;
begin
  for e in select * from job_variation_entries where variation_type = 'do_and_charge' and status = 'to_bill' and cost_centre_id is null loop
    insert into cost_centres (project_id, name, description, sort_order, markup_percent, quoted_amount, variation_entry_id)
    values (
      e.project_id,
      left('Variation ' || coalesce(e.variation_number, 0) || ': ' || e.description, 90),
      'Out-of-scope work logged ' || e.work_date,
      coalesce((select max(sort_order) + 1 from cost_centres where project_id = e.project_id), 0),
      coalesce((select default_markup_percent from company_settings where id = 1), 45),
      0,
      e.id
    ) returning id into cc;
    update job_variation_entries set cost_centre_id = cc where id = e.id;
  end loop;
end $$;

-- The client's quote shows a variation stage only once it is an approved fixed-price
-- variation (do-and-charge ones are billed on invoices, never part of the quote).
-- This is get_quote_by_token as in migration 142, plus that rule and an
-- is_variation / variation_reason pair on each stage.
create or replace function public.get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
as $function$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
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
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$function$;

-- Public, token-gated read for the client's "approve this variation" page: the
-- original quote exactly as they accepted it, this variation (reason + priced
-- lines), and any variations they have already approved on the job.
create or replace function public.get_variation_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  ve job_variation_entries%rowtype;
  p projects%rowtype;
  src_token text;
begin
  select * into ve from job_variation_entries
  where variation_token = p_token and variation_type = 'fixed' and approval_status in ('sent', 'approved', 'declined');
  if not found then
    return null;
  end if;
  select * into p from projects where id = ve.project_id;
  select coalesce((select s.quote_token from projects s where s.id = p.source_quote_id), p.quote_token) into src_token;

  return jsonb_build_object(
    'variation', jsonb_build_object(
      'id', ve.id, 'number', ve.variation_number, 'description', ve.description, 'reason', ve.reason,
      'lines', ve.fixed_lines, 'approval_status', ve.approval_status, 'sent_at', ve.sent_at,
      'approved_at', ve.approved_at, 'signed_by_name', ve.signed_by_name,
      'signature_data_url', case when ve.approval_status = 'approved' then ve.signature_data_url else null end,
      'job_number', p.job_number, 'job_name', p.name, 'client_name', p.client_name
    ),
    'quote', get_quote_by_token(src_token)::jsonb,
    'other_variations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'number', o.variation_number, 'description', o.description, 'reason', o.reason,
        'lines', o.fixed_lines, 'approved_at', o.approved_at
      ) order by o.variation_number), '[]'::jsonb)
      from job_variation_entries o
      where o.project_id = ve.project_id and o.variation_type = 'fixed' and o.approval_status = 'approved' and o.id <> ve.id
    )
  );
end;
$function$;

grant execute on function public.get_variation_by_token(uuid) to anon, authenticated;
