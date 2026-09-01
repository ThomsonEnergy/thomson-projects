-- Migration 064 — STC calculator fields
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Adds the inputs behind the Clean Energy Regulator's STC formula
-- (system size in kW x postcode zone rating x deeming years, rounded
-- down) to each stage, alongside the existing stc_total dollar figure it
-- feeds into. stc_total itself is untouched - it stays the number
-- everything downstream (invoice claims, Xero push) already reads.

alter table cost_centres add column if not exists stc_system_kw numeric;
alter table cost_centres add column if not exists stc_zone_rating numeric not null default 1.382;
alter table cost_centres add column if not exists stc_install_year integer;
alter table cost_centres add column if not exists stc_price_per_certificate numeric;

-- get_quote_by_token never returned stc_total, so the client-facing quote
-- had no way to show the STC credit at all - add it to the same
-- json_build_object the function already returns per stage.
create or replace function get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
set search_path = public
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
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c where c.project_id = p.id
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$$;

grant execute on function get_quote_by_token(text) to anon, authenticated;
