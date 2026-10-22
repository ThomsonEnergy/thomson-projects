-- Electricity bill reader and savings estimate on quotes (docs/IDEAS_BACKLOG.md item 29).
-- projects.bill_reading: what the AI read from the customer's electricity bill plus the sizing it
-- worked out (jsonb, see read-electricity-bill.js). projects.sow_documents: the scope of works
-- supporting documents, so they survive a reload. projects.show_roi: the proposal's savings
-- section can be switched off per quote. quote_compliance_answers.photo_paths: a checklist item
-- can hold several files (a multi-page bill, consent forms); photo_path stays as the first one.

alter table public.projects add column if not exists bill_reading jsonb;
alter table public.projects add column if not exists sow_documents jsonb;
alter table public.projects add column if not exists show_roi boolean not null default true;
alter table public.quote_compliance_answers add column if not exists photo_paths jsonb;

-- The proposal needs the bill reading, the system size, the zone and a few of the answers for
-- the savings estimate. Same function as migration 20261117000000 with those added.
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
        'stc_quantity', 'stc_total', 'bstc_quantity', 'bstc_total', 'stc_system_kw', 'stc_zone_rating', 'bill_reading', 'show_roi'])
    ),
    -- the pre-quote answers the savings estimate needs (never the whole set: it holds private notes)
    'roi_answers', json_build_object(
      'existing_system', p.template_answers->>'existing_system',
      'existing_system_detail', p.template_answers->>'existing_system_detail',
      'existing_pv', p.template_answers->>'existing_pv',
      'with_battery', p.template_answers->>'with_battery',
      'battery_kwh_wanted', p.template_answers->>'battery_kwh_wanted',
      'export_limit', p.template_answers->>'export_limit'
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

revoke execute on function public.get_quote_by_token(text) from public;
grant execute on function public.get_quote_by_token(text) to anon, authenticated;
