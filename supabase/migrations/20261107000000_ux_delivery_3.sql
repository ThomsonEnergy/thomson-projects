-- UX delivery 3: two database changes (docs/UX_REVIEW.md items 56 and 46).

-- Item 56 (docs/UX_REVIEW.md): removing a material from a do-and-charge variation
-- puts its Stock back on the Warehouse shelf and deletes the row in one step, all or
-- nothing. Replaces the browser doing adjustWarehouseStock() then a delete, where a
-- failed put-back was only logged to the console.
-- Same permission rule as the "variation materials deletable" policy.

create or replace function public.variation_material_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m job_variation_materials;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into m from job_variation_materials where id = p_id for update;
  if m.id is null then
    raise exception 'That material has already been removed.';
  end if;

  -- coalesce: a null created_by (creator's profile deleted) must refuse, not slip through
  if not coalesce(is_pricing_role()
          or (m.created_by = auth.uid()
              and m.kind <> 'other'
              and exists (select 1 from job_variation_entries e
                          where e.id = m.variation_id and e.status = 'to_bill')), false) then
    raise exception 'You cannot remove this material.';
  end if;

  if m.stock_deducted and m.material_id is not null then
    perform _stock_adjust(m.material_id, 'warehouse', null, m.quantity);
  end if;

  delete from job_variation_materials where id = m.id;
end;
$$;

revoke execute on function public.variation_material_delete(uuid) from public, anon;
grant execute on function public.variation_material_delete(uuid) to authenticated;

-- UX item 46: the person who took a site photo, or Admin / Finance, can delete it.
-- project_photos had select, insert and update policies but no delete policy (checked on production 20 Oct 2026),
-- so nobody could remove a wrong or blurry photo. The site-photos bucket already lets staff delete files
-- ("staff can delete site photos" on storage.objects), so storage needs no change.
drop policy if exists "Uploader or admin/finance delete project photos" on public.project_photos;
create policy "Uploader or admin/finance delete project photos" on public.project_photos
  for delete to authenticated
  using (staff_id = (select auth.uid()) or (select public.is_finance_role()));
