-- Migration 091 — Group prebuild-sourced line items for the client-facing quote
-- Already applied directly via Supabase MCP apply_migration on 2026-09-09.
--
-- Internally each prebuild component still explodes into its own
-- cost_centre_line_items row (staff need to see/edit every labour/material/
-- markup line individually). These two columns let the client-facing quote
-- collapse a group of components that came from the same "add prebuild"
-- action back into a single line showing the prebuild's client-facing
-- description, without touching how staff see things.
--
-- prebuild_client_description is a snapshot taken at add-time (not a live
-- join to prebuilds.client_description) - same "editable per use without
-- changing the master template" principle used everywhere else prebuilds
-- get copied onto a quote.

alter table cost_centre_line_items add column if not exists prebuild_group_id uuid;
alter table cost_centre_line_items add column if not exists prebuild_client_description text;

create or replace function get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
as $$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
    'cost_centres', (
      select coalesce(json_agg(
        json_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'photo_groups', (
            select coalesce(json_agg(
              json_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::json)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            -- Sell-price amount only, computed here - never expose raw
            -- unit_cost to the client-facing quote. Labour's unit_cost is
            -- already a sell/billable rate (see addLineItem's rate-tier
            -- assignment); only materials need the stage's markup% applied
            -- to go from cost to sell - same split updateStageTotals()
            -- already uses to compute the stage's own quoted_amount, so
            -- these line amounts sum to exactly that total.
            select coalesce(json_agg(
              json_build_object('description', li.description, 'amount', li.amount)
              order by li.sort_order
            ), '[]'::json)
            from (
              select cli.description as description,
                (case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                      else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                 end) as amount,
                cli.sort_order as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is null

              union all

              select max(cli.prebuild_client_description) as description,
                sum(case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                         else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                    end) as amount,
                min(cli.sort_order) as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is not null
              group by cli.prebuild_group_id
            ) li
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c where c.project_id = p.id
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
$$;
