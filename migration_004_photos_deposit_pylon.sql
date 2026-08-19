-- Only needed if you already ran schema.sql before this update. Safe to run
-- even if you haven't, it will just do nothing.

alter table projects add column if not exists deposit_percent numeric(5,2) not null default 10;
alter table projects add column if not exists pylon_link text not null default '';
alter table projects add column if not exists pylon_project_id text not null default '';
alter table projects add column if not exists pylon_data jsonb not null default '{}';

create table if not exists cost_centre_photo_groups (
  id uuid primary key default gen_random_uuid(),
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  description text not null default '',
  photos jsonb not null default '[]',
  sort_order int not null default 0
);

create index if not exists cost_centre_photo_groups_cost_centre_id_idx on cost_centre_photo_groups (cost_centre_id);

alter table cost_centre_photo_groups enable row level security;
drop policy if exists "staff full access on cost_centre_photo_groups" on cost_centre_photo_groups;
create policy "staff full access on cost_centre_photo_groups"
  on cost_centre_photo_groups for all to authenticated using (true) with check (true);

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
