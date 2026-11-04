-- Charge rate levels (docs/IDEAS_BACKLOG.md item 46, spec A3 and D1).
--
--  * rate_cards: named levels as a percent of the Billable Rates (Standard 100% from the start and
--    the default; the owner adds Commercial 115%, Mates rates 85%...). Everyone reads, pricing roles
--    manage (Settings > Billable Rates, js/settings-rate-cards.js).
--  * clients.rate_card_id (the client's level) and projects.rate_card_id (the quote's or job's level,
--    set from the client when the row is made or the client picked, changeable on the job page).
--  * _rate_factor(project): the multiplier every rate reader uses (quote labour lines, variations,
--    invoice actuals, the Schedule of Rates the client reads). A job with no level is Standard.
--  * get_schedule_of_rates(p_project_id) prints a job's level; get_quote_by_token scales an
--    estimate's Schedule of Rates and names the level.

create table if not exists public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  percent numeric not null default 100 check (percent > 0 and percent <= 500),
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists rate_cards_one_default_idx on public.rate_cards (is_default) where is_default;
insert into public.rate_cards (name, percent, is_default, sort_order)
  select 'Standard', 100, true, 0 where not exists (select 1 from public.rate_cards);

alter table public.rate_cards enable row level security;
drop policy if exists "Everyone reads rate cards" on public.rate_cards;
create policy "Everyone reads rate cards" on public.rate_cards for select to authenticated using (true);
drop policy if exists "Pricing roles insert rate cards" on public.rate_cards;
create policy "Pricing roles insert rate cards" on public.rate_cards for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles update rate cards" on public.rate_cards;
create policy "Pricing roles update rate cards" on public.rate_cards for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles delete rate cards" on public.rate_cards;
create policy "Pricing roles delete rate cards" on public.rate_cards for delete to authenticated using ((select is_pricing_role()) and not is_default);

alter table public.clients add column if not exists rate_card_id uuid references public.rate_cards(id) on delete set null;
alter table public.projects add column if not exists rate_card_id uuid references public.rate_cards(id) on delete set null;
create index if not exists clients_rate_card_id_idx on public.clients (rate_card_id);
create index if not exists projects_rate_card_id_idx on public.projects (rate_card_id);

-- The multiplier for a quote or job: its level's percent / 100, Standard (1) when it has none.
create or replace function public._rate_factor(p_project_id uuid)
returns numeric language sql stable set search_path = public as $$
  select coalesce((select rc.percent from projects p join rate_cards rc on rc.id = p.rate_card_id where p.id = p_project_id), 100) / 100;
$$;
revoke all on function public._rate_factor(uuid) from public, anon;
grant execute on function public._rate_factor(uuid) to authenticated, service_role;

-- A new quote or job, or one given a client, takes the client's level unless one is already set.
create or replace function public.projects_rate_card_default()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.rate_card_id is null and new.client_id is not null then
    select rate_card_id into new.rate_card_id from clients where id = new.client_id;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_projects_rate_card_default on public.projects;
create trigger trg_projects_rate_card_default before insert or update of client_id on public.projects
  for each row execute function public.projects_rate_card_default();

-- The Schedule of Rates: at a job's level when one is given (its Company docs PDF), else Standard
-- (the public rates page and the Documents page). Replaces the no-argument version.
drop function if exists public.get_schedule_of_rates();
create or replace function public.get_schedule_of_rates(p_project_id uuid default null)
 returns json
 language sql
 stable security definer
 set search_path = public
as $function$
  select json_build_object(
    'rates', (
      select coalesce(json_agg(json_build_object('name', t.name, 'sell_rate', round(t.sell_rate * coalesce(_rate_factor(p_project_id), 1), 2)) order by t.sort_order), '[]'::json)
      from billable_rate_tiers t
    ),
    'reviewed_on', (select s.rates_reviewed_on from company_settings s where s.id = 1),
    'rate_card_name', (select rc.name from projects p join rate_cards rc on rc.id = p.rate_card_id where p.id = p_project_id and rc.percent <> 100)
  );
$function$;
revoke execute on function public.get_schedule_of_rates(uuid) from public;
grant execute on function public.get_schedule_of_rates(uuid) to anon, authenticated;

-- get_quote_by_token (migration 20261124131544) with the estimate's Schedule of Rates at the quote's
-- level and the level's name (null at Standard).
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
          jsonb_build_object('name', t.name, 'sell_rate', round(t.sell_rate * _rate_factor(p.id), 2))
          order by t.sort_order
        ), '[]'::jsonb)
        from billable_rate_tiers t
      ) else null end
    ),
    'rate_card_name', (select rc.name from rate_cards rc where rc.id = p.rate_card_id and rc.percent <> 100)
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result::json;
end;
$$;
