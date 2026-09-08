-- Migration 092 — Let a whole prebuild instance be rescaled by one quantity,
-- and show quantities on the client-facing quote.
-- Already applied directly via Supabase MCP apply_migration on 2026-09-09.
--
-- prebuild_base_quantity is the master prebuild_component's own quantity,
-- captured un-multiplied at add-time. The group's current "how many of
-- this prebuild" multiplier is never stored directly - it's derived as
-- quantity / prebuild_base_quantity for any one row in the group, since
-- every row in a group is scaled together (same principle as
-- prebuild_client_description - a snapshot, not a live link back to the
-- master template).

alter table cost_centre_line_items add column if not exists prebuild_base_quantity numeric;

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
            -- already a sell/billable rate; only materials need the
            -- stage's markup% applied to go cost -> sell, matching
            -- updateStageTotals()'s existing split so these amounts sum
            -- to exactly the stage's own quoted_amount.
            --
            -- quantity: for an ungrouped line, its own quantity (plus
            -- item_type, so the client page can show "hrs" for labour).
            -- For a prebuild group, the derived instance count (how many
            -- of that prebuild) rather than any one component's own
            -- quantity, which wouldn't mean anything summed across
            -- differently-united components (hours, metres, each).
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
