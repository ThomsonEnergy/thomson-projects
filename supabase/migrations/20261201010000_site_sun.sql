-- Item 75 (backlog item 75): the savings estimate uses the job's own sun records.
--
--  * projects.lat, projects.lng: where the site is (from the Pylon design's site location, or the
--    address looked up once). Backlog item 4 (weather) reuses the same two columns.
--  * projects.site_sun: the site's sun figures as the estimate uses them (kWh a day from each kW
--    of panels, the four season factors, the share of clear days and what a dull day makes), with
--    the years of records behind them and the address they were worked out for. Written by the
--    server only (netlify/functions/site-sun.js).
--  * sun_climate: ten years of daily sun records boiled down, one row per half degree cell, so
--    an area is fetched from NASA's POWER service once. Staff can read it; only the server
--    writes it (no insert, update or delete policy).
--  * get_quote_by_token also returns site_sun, so the client's proposal runs on the same sun
--    figures as the quote page. It is otherwise word for word the function from migration
--    20261130080000. No lat or lng goes to the client's page.

alter table public.projects
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists site_sun jsonb;

create table if not exists public.sun_climate (
  cell text primary key,
  lat double precision not null,
  lng double precision not null,
  years text not null,
  summary jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.sun_climate enable row level security;

drop policy if exists "Staff read sun climate" on public.sun_climate;
create policy "Staff read sun climate" on public.sun_climate
  for select to authenticated using (true);

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
         'stc_quantity', 'stc_total', 'bstc_quantity', 'bstc_total', 'stc_system_kw', 'stc_zone_rating', 'show_roi', 'battery_kwh', 'site_sun']))
      || jsonb_build_object(
        'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
        'bill_reading', case when p.bill_reading is null then null else (
          select jsonb_object_agg(e.key, e.value) from jsonb_each(p.bill_reading) e
          where e.key = any (array['retailer', 'billing_days', 'bill_total', 'total_kwh', 'daily_average_kwh', 'peak_kwh', 'off_peak_kwh',
            'shoulder_kwh', 'controlled_load_kwh', 'solar_export_kwh', 'solar_soak_kwh', 'feed_in_c_per_kwh', 'usage_rate_c_per_kwh',
            'usage_rates', 'supply_charge_c_per_day', 'tariff_type', 'tou_hours', 'tou_other', 'tou_schedule',
            'usage_discount_percent', 'bill_discount_percent', 'fixed_credits_total', 'other_charges_total'])) end,
        'pylon_data', case when p.pylon_data is null then null else jsonb_build_object(
          'module_types', p.pylon_data -> 'module_types',
          'inverter_types', p.pylon_data -> 'inverter_types',
          'storage_types', p.pylon_data -> 'storage_types',
          'summary', jsonb_build_object('dc_output_kw', p.pylon_data -> 'summary' -> 'dc_output_kw')) end,
        'roi_inputs', case when p.roi_inputs is null then null else (
          select jsonb_object_agg(e.key, case
            -- an override goes out as its switch and its figures only: the reason and who set it stay with staff
            when e.key = 'overrides' then (
              select coalesce(jsonb_object_agg(o.key, jsonb_build_object('on', o.value -> 'on', 'values', o.value -> 'values')), '{}'::jsonb)
              from jsonb_each(case when jsonb_typeof(e.value) = 'object' then e.value else '{}'::jsonb end) o
              where jsonb_typeof(o.value) = 'object')
            else e.value end)
          from jsonb_each(p.roi_inputs) e
          where e.key = any (array['solar_price', 'battery_price', 'current', 'alt', 'plan_options',
            'export', 'grid_charge', 'bill_gst', 'assumptions', 'overrides'])) end
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
revoke execute on function public.get_quote_by_token(text) from public;
grant execute on function public.get_quote_by_token(text) to anon, authenticated;
