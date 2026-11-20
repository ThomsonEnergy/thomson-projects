-- Item 103: an address is kept in parts beside its line of text, and item 101d: who books a job can
-- see the Formbay accredited installer.
--
-- address_parts: { unit, street_number, street_name, street_type, suburb, state, postcode, lat, lng,
-- place_id, formatted } from Google's address lookup (public/js/address-box.js). Null when the
-- address was typed and Google does not know it. The line of text stays what everything prints.
--
-- Additions only. No money, stock or payroll. No table's RLS changes.

alter table public.projects add column if not exists address_parts jsonb;
alter table public.clients add column if not exists address_parts jsonb;
alter table public.clients add column if not exists lat double precision;
alter table public.clients add column if not exists lng double precision;
alter table public.client_sites add column if not exists address_parts jsonb;
alter table public.client_sites add column if not exists lat double precision;
alter table public.client_sites add column if not exists lng double precision;
alter table public.company_settings add column if not exists address_parts jsonb;

-- Google's browser key for the address lookup, for any active staff member. company_settings is
-- read by pricing roles only, so until now nobody else got address suggestions. The key is a browser
-- key (it is sent to every browser that uses it, and Google limits it to this site's addresses).
create or replace function public.google_maps_browser_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.google_maps_api_key
  from company_settings s
  where s.id = 1
    and exists (select 1 from profiles p where p.id = (select auth.uid()) and p.active);
$$;
revoke execute on function public.google_maps_browser_key() from public, anon;
grant execute on function public.google_maps_browser_key() to authenticated;

-- The accredited installer on each Formbay form of a job, for the booking panel (formbay_forms itself
-- is read by pricing roles only; the person booking needs just the name and the kind of form).
create or replace function public.formbay_installers(p_project_id uuid)
returns table (ftype text, installer text)
language sql
stable
security definer
set search_path = public
as $$
  select f.ftype, f.form ->> 'installer_name'
  from formbay_forms f
  where f.project_id = p_project_id
    and coalesce(f.form ->> 'installer_name', '') <> ''
    and exists (select 1 from profiles p where p.id = (select auth.uid()) and p.active)
  order by f.created_at;
$$;
revoke execute on function public.formbay_installers(uuid) from public, anon;
grant execute on function public.formbay_installers(uuid) to authenticated;
