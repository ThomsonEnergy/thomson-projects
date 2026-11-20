-- Quote stages saved in one go (backlog item 99 PR 2, owner 20 Nov 2026: "definitely auto save
-- pricing otherwise you add pricing in forget to hit save and it doesn't stick").
--
-- The quote steps now save the stage table as it is typed (public/js/quote-autosave.js). It is
-- money, so the browser no longer writes the stages piece by piece: it sends every stage of the
-- quote to this one function, which saves all of them or none.
--
-- save_quote_stages(quote, stages):
--  * Pricing roles only, and only a quote that can still be edited (not a job, not an approved
--    quote: those are changed in the job's own editor). The quote's row is locked for the save,
--    so two saves of one quote never interleave.
--  * Each stage arrives with its id (the page makes the id for a new stage, so a save that is
--    sent twice updates the stage instead of adding a second one). A stage already on the quote
--    is updated in place, a new one is added, and its line items and photo groups are replaced.
--    An id that belongs to another quote or job fails on the primary key and nothing is saved.
--  * A stage of the quote that is not in the list is removed, unless it has invoices, claims,
--    purchase orders, logged time, materials or a variation against it: then nothing is saved
--    and the message says which stage.
--  * The totals (quoted amount, estimated labour and materials) are the ones the page worked out
--    from the line items, as before: this function stores them, it does not reprice the quote.
--
-- Runs as the caller (security invoker), so the row level security on cost_centres and its line
-- items still applies on top of the role check here.

create or replace function public.save_quote_stages(p_project_id uuid, p_stages jsonb)
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
    select id, name from cost_centres where project_id = p_project_id and not (id = any (v_keep))
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

revoke execute on function public.save_quote_stages(uuid, jsonb) from public, anon;
grant execute on function public.save_quote_stages(uuid, jsonb) to authenticated;
