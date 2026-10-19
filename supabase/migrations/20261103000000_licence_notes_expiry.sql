-- Licence and insurance notes, "Ask to update" for employee licences, and the nightly
-- licence expiry agent (netlify/functions/sweep-licence-expiry.js).
--   notes: free text ("Paid renewal 15 Oct, waiting on card"), who and when stamped by a trigger.
--   update_requested_*: an Admin asked the employee to update this licence; cleared by the
--   trigger once a new expiry date or file is saved.

alter table public.company_credentials
  add column if not exists notes text,
  add column if not exists notes_updated_at timestamptz,
  add column if not exists notes_updated_by uuid references public.profiles(id) on delete set null;

alter table public.profile_licences
  add column if not exists notes text,
  add column if not exists notes_updated_at timestamptz,
  add column if not exists notes_updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists update_requested_at timestamptz,
  add column if not exists update_requested_by uuid references public.profiles(id) on delete set null;

create index if not exists company_credentials_notes_updated_by_idx on public.company_credentials (notes_updated_by);
create index if not exists profile_licences_profile_id_idx on public.profile_licences (profile_id);
create index if not exists profile_licences_notes_updated_by_idx on public.profile_licences (notes_updated_by);
create index if not exists profile_licences_update_requested_by_idx on public.profile_licences (update_requested_by);
create index if not exists profile_licences_expiry_idx on public.profile_licences (expiry_date);

-- Stamps who wrote the note and when; clears an update request once the licence is renewed.
create or replace function public.trg_licence_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.notes, '') <> '' then
      new.notes_updated_at := now();
      new.notes_updated_by := auth.uid();
    end if;
    return new;
  end if;
  if new.notes is distinct from old.notes then
    new.notes_updated_at := now();
    new.notes_updated_by := auth.uid();
  else
    new.notes_updated_at := old.notes_updated_at;
    new.notes_updated_by := old.notes_updated_by;
  end if;
  if tg_table_name = 'profile_licences'
     and (new.expiry_date is distinct from old.expiry_date or new.file_path is distinct from old.file_path) then
    new.update_requested_at := null;
    new.update_requested_by := null;
  end if;
  return new;
end $$;

drop trigger if exists company_credentials_stamp on public.company_credentials;
create trigger company_credentials_stamp before insert or update on public.company_credentials
  for each row execute function public.trg_licence_stamp();
drop trigger if exists profile_licences_stamp on public.profile_licences;
create trigger profile_licences_stamp before insert or update on public.profile_licences
  for each row execute function public.trg_licence_stamp();

revoke execute on function public.trg_licence_stamp() from public, anon, authenticated;

-- Admin only: asks the employee to update one of their licences (phone notification that
-- opens Settings, My licences, on that licence).
create or replace function public.request_licence_update(p_licence_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l record;
begin
  if not is_admin() then raise exception 'Only Admin can ask for a licence update'; end if;
  update profile_licences
     set update_requested_at = now(), update_requested_by = auth.uid()
   where id = p_licence_id
  returning id, profile_id, licence_name, expiry_date into l;
  if l.id is null then raise exception 'Licence not found'; end if;
  perform create_notification(
    l.profile_id, 'licence',
    'Please update your ' || l.licence_name,
    case when l.expiry_date is null then 'Add the expiry date and upload a photo of the current licence.'
         when l.expiry_date < sydney_today() then 'It expired ' || to_char(l.expiry_date, 'DD Mon YYYY') || '. Upload the renewed licence and its new expiry date.'
         else 'It runs out ' || to_char(l.expiry_date, 'DD Mon YYYY') || '. Upload the renewed licence and its new expiry date.' end,
    '/settings.html?licence=' || l.id,
    auth.uid(),
    'licence-update-request-' || l.id || '-' || extract(epoch from now())::bigint
  );
end $$;

revoke execute on function public.request_licence_update(uuid) from public, anon;
grant execute on function public.request_licence_update(uuid) to authenticated;
