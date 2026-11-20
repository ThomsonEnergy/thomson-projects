-- Item 99 go-live on production, 20 Nov 2026 (owner: "Yes push to main"). One transaction.
-- Paste the whole file into Supabase > SQL Editor on the production project and press Run.
-- It is safe to run twice.
--  1. A copy of the quote tables as they are now, in the schema backup_20261120 (not reachable
--     from the app). Drop the schema once the owner is happy with the new quote page.
--  2. Migration 20261215000000: quote_save_points (Undo on the quote steps).
--  3. Migration 20261216120000: save_quote_stages (the stage table saved all or nothing).
--  4. Both migrations recorded, so the repo and the database agree.
-- The same SQL as supabase/migrations/20261215000000_quote_save_points.sql and
-- supabase/migrations/20261216120000_save_quote_stages.sql: if either file changes, change this too.
begin;

-- 1. the copy
create schema if not exists backup_20261120;
create table if not exists backup_20261120.projects as select * from public.projects;
create table if not exists backup_20261120.cost_centres as select * from public.cost_centres;
create table if not exists backup_20261120.cost_centre_line_items as select * from public.cost_centre_line_items;
create table if not exists backup_20261120.cost_centre_photo_groups as select * from public.cost_centre_photo_groups;
create table if not exists backup_20261120.payment_milestones as select * from public.payment_milestones;

-- 2. quote_save_points
create table if not exists public.quote_save_points (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  taken_at timestamptz not null default now(),
  taken_by uuid default auth.uid(),
  reason text not null,
  snapshot jsonb not null
);

create index if not exists quote_save_points_project_idx on public.quote_save_points (project_id, taken_at desc);

alter table public.quote_save_points enable row level security;

drop policy if exists "Pricing roles read quote save points" on public.quote_save_points;
create policy "Pricing roles read quote save points" on public.quote_save_points
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add quote save points" on public.quote_save_points;
create policy "Pricing roles add quote save points" on public.quote_save_points
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove quote save points" on public.quote_save_points;
create policy "Pricing roles remove quote save points" on public.quote_save_points
  for delete to authenticated using ((select is_pricing_role()));

-- 3. save_quote_stages
create or replace function public.save_quote_stages(p_project_id uuid, p_stages jsonb, p_remove uuid[] default '{}')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_stage jsonb;
  v_id uuid;
  v_keep uuid[] := '{}';
  v_pos integer := 0;
  v_gone record;
begin
  if not is_pricing_role() then
    raise exception 'Only Admin, Finance or Sales can change a quote''s stages.';
  end if;
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' then
    raise exception 'The stages did not arrive as a list.';
  end if;

  perform 1 from projects
    where id = p_project_id and job_number is null and status is distinct from 'approved'
    for update;
  if not found then
    raise exception 'This quote can no longer be changed here (it was approved, or it is a job). Reload the page.';
  end if;

  for v_stage in select value from jsonb_array_elements(p_stages) loop
    v_id := nullif(v_stage->>'id', '')::uuid;
    if v_id is null then
      raise exception 'A stage arrived without its id.';
    end if;
    if coalesce(btrim(v_stage->>'name'), '') = '' then
      raise exception 'Every stage needs a name.';
    end if;

    update cost_centres set
      name = btrim(v_stage->>'name'),
      description = v_stage->>'description',
      markup_percent = coalesce((v_stage->>'markup_percent')::numeric, 0),
      stc_total = coalesce((v_stage->>'stc_total')::numeric, 0),
      stc_quantity = (v_stage->>'stc_quantity')::numeric,
      stc_system_kw = (v_stage->>'stc_system_kw')::numeric,
      stc_zone_rating = coalesce((v_stage->>'stc_zone_rating')::numeric, 1.382),
      stc_install_year = (v_stage->>'stc_install_year')::integer,
      stc_price_per_certificate = (v_stage->>'stc_price_per_certificate')::numeric,
      estimated_labour_cost = coalesce((v_stage->>'estimated_labour_cost')::numeric, 0),
      estimated_material_cost = coalesce((v_stage->>'estimated_material_cost')::numeric, 0),
      quoted_amount = coalesce((v_stage->>'quoted_amount')::numeric, 0),
      sort_order = v_pos
    where id = v_id and project_id = p_project_id;
    if not found then
      insert into cost_centres (
        id, project_id, name, description, markup_percent, stc_total, stc_quantity, stc_system_kw,
        stc_zone_rating, stc_install_year, stc_price_per_certificate, estimated_labour_cost,
        estimated_material_cost, quoted_amount, sort_order
      ) values (
        v_id, p_project_id, btrim(v_stage->>'name'), v_stage->>'description',
        coalesce((v_stage->>'markup_percent')::numeric, 0),
        coalesce((v_stage->>'stc_total')::numeric, 0),
        (v_stage->>'stc_quantity')::numeric,
        (v_stage->>'stc_system_kw')::numeric,
        coalesce((v_stage->>'stc_zone_rating')::numeric, 1.382),
        (v_stage->>'stc_install_year')::integer,
        (v_stage->>'stc_price_per_certificate')::numeric,
        coalesce((v_stage->>'estimated_labour_cost')::numeric, 0),
        coalesce((v_stage->>'estimated_material_cost')::numeric, 0),
        coalesce((v_stage->>'quoted_amount')::numeric, 0),
        v_pos
      );
    end if;

    delete from cost_centre_line_items where cost_centre_id = v_id;
    insert into cost_centre_line_items (
      cost_centre_id, description, item_type, quantity, unit_cost, rate_tier_id, sort_order,
      prebuild_group_id, prebuild_client_description, prebuild_base_quantity, ai_suggested
    )
    select v_id, li->>'description', li->>'item_type',
      coalesce((li->>'quantity')::numeric, 0), coalesce((li->>'unit_cost')::numeric, 0),
      nullif(li->>'rate_tier_id', '')::uuid, (ord - 1)::integer,
      nullif(li->>'prebuild_group_id', '')::uuid, li->>'prebuild_client_description',
      (li->>'prebuild_base_quantity')::numeric, coalesce((li->>'ai_suggested')::boolean, false)
    from jsonb_array_elements(coalesce(v_stage->'lineItems', '[]'::jsonb)) with ordinality as t(li, ord);

    delete from cost_centre_photo_groups where cost_centre_id = v_id;
    insert into cost_centre_photo_groups (cost_centre_id, description, photos, sort_order)
    select v_id, coalesce(pg->>'description', ''), coalesce(pg->'photos', '[]'::jsonb), (ord - 1)::integer
    from jsonb_array_elements(coalesce(v_stage->'photoGroups', '[]'::jsonb)) with ordinality as t(pg, ord);

    v_keep := v_keep || v_id;
    v_pos := v_pos + 1;
  end loop;

  for v_gone in
    select id, name from cost_centres
    where project_id = p_project_id and id = any (coalesce(p_remove, '{}')) and not (id = any (v_keep))
  loop
    if exists (select 1 from invoices where cost_centre_id = v_gone.id)
      or exists (select 1 from invoice_claims where cost_centre_id = v_gone.id)
      or exists (select 1 from invoice_line_items where cost_centre_id = v_gone.id)
      or exists (select 1 from credit_note_claims where cost_centre_id = v_gone.id)
      or exists (select 1 from purchase_orders where cost_centre_id = v_gone.id)
      or exists (select 1 from time_entries where cost_centre_id = v_gone.id or selected_cost_centre_ids @> array[v_gone.id])
      or exists (select 1 from job_material_usage where cost_centre_id = v_gone.id)
      or exists (select 1 from job_variation_entries where cost_centre_id = v_gone.id)
    then
      raise exception 'Can''t remove the stage "%": it has invoices, purchase orders, logged time or materials against it. Reload the page to get it back.', v_gone.name;
    end if;
    delete from cost_centres where id = v_gone.id;
  end loop;

  return jsonb_build_object('stage_ids', to_jsonb(v_keep));
end;
$$;

revoke execute on function public.save_quote_stages(uuid, jsonb, uuid[]) from public, anon;
grant execute on function public.save_quote_stages(uuid, jsonb, uuid[]) to authenticated;

-- 4. recorded
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261215000000', 'quote_save_points'),
  ('20261216120000', 'save_quote_stages')
on conflict (version) do nothing;

commit;

-- What to see afterwards (run on its own): one row, both true.
-- select to_regclass('public.quote_save_points') is not null as save_points_table,
--        exists (select 1 from pg_proc where proname = 'save_quote_stages') as stages_function;
