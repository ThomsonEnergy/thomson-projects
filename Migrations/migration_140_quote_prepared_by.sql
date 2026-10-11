-- The client-facing quote shows who prepared it ("Prepared by: <name>"). The
-- page is opened by the client without logging in, and profiles can't be read
-- by an anonymous visitor, so the name comes back from get_quote_by_token
-- itself (a security definer function). Only the full name of the staff member
-- who created the quote is exposed - nothing else from their profile.
--
-- This is the existing function, unchanged, plus one new 'prepared_by' key.

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
$function$;
