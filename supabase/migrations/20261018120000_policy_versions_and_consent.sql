-- Versioned onboarding documents, AI and location consent (backlog item 6).
--
-- A document's version goes up when an admin presses "Publish new version";
-- anyone who has not signed the current version is sent to
-- /policy-update.html on their next login. Consent documents (consent_type
-- set) need an I agree / I don't agree answer, which sets or clears the
-- person's consent on profiles. Staff can never set those columns directly:
-- only signing a consent document or withdraw_consent() can.

alter table public.onboarding_documents
  add column if not exists version integer not null default 1,
  add column if not exists consent_type text;

alter table public.onboarding_documents drop constraint if exists onboarding_documents_consent_type_check;
alter table public.onboarding_documents add constraint onboarding_documents_consent_type_check
  check (consent_type in ('ai', 'location'));

alter table public.onboarding_document_signatures
  add column if not exists document_version integer not null default 1,
  add column if not exists response text;

alter table public.onboarding_document_signatures drop constraint if exists onboarding_document_signatures_response_check;
alter table public.onboarding_document_signatures add constraint onboarding_document_signatures_response_check
  check (response in ('agree', 'disagree'));

create index if not exists onboarding_document_signatures_profile_doc_idx
  on public.onboarding_document_signatures (profile_id, document_id);
create index if not exists onboarding_document_signatures_document_id_idx
  on public.onboarding_document_signatures (document_id);

-- Current consent per person. Null consent_at = not consented. No column
-- SELECT grant for authenticated: read through get_consent_status().
alter table public.profiles
  add column if not exists ai_consent_at timestamptz,
  add column if not exists ai_consent_withdrawn_at timestamptz,
  add column if not exists location_consent_at timestamptz,
  add column if not exists location_consent_withdrawn_at timestamptz;

-- Before each signature: stamp the document's current version (never trust
-- the browser for it), require an answer on consent documents, and apply
-- that answer to the signer's profile.
create or replace function public.trg_onboarding_signature_consent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc onboarding_documents%rowtype;
begin
  select * into v_doc from onboarding_documents where id = new.document_id;
  if not found then return new; end if;

  new.document_version := v_doc.version;

  if v_doc.consent_type is null then
    new.response := null;
    return new;
  end if;

  if new.response is null then
    raise exception 'Choose I agree or I don''t agree before signing';
  end if;

  perform set_config('app.consent_write', 'on', true);
  if v_doc.consent_type = 'ai' then
    update profiles set
      ai_consent_at = case when new.response = 'agree' then now() end,
      ai_consent_withdrawn_at = case when new.response = 'agree' then null
        when ai_consent_at is not null then now() else ai_consent_withdrawn_at end
    where id = new.profile_id;
  else
    update profiles set
      location_consent_at = case when new.response = 'agree' then now() end,
      location_consent_withdrawn_at = case when new.response = 'agree' then null
        when location_consent_at is not null then now() else location_consent_withdrawn_at end
    where id = new.profile_id;
  end if;
  perform set_config('app.consent_write', 'off', true);
  return new;
end $$;

drop trigger if exists onboarding_signature_consent on public.onboarding_document_signatures;
create trigger onboarding_signature_consent
  before insert on public.onboarding_document_signatures
  for each row execute function public.trg_onboarding_signature_consent();

-- Nobody (admins included) edits consent columns directly.
create or replace function public.trg_guard_consent_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.ai_consent_at is distinct from old.ai_consent_at
      or new.ai_consent_withdrawn_at is distinct from old.ai_consent_withdrawn_at
      or new.location_consent_at is distinct from old.location_consent_at
      or new.location_consent_withdrawn_at is distinct from old.location_consent_withdrawn_at)
     and coalesce(current_setting('app.consent_write', true), '') <> 'on' then
    raise exception 'Consent can only be changed by signing the consent form or withdrawing it';
  end if;
  return new;
end $$;

drop trigger if exists guard_consent_columns on public.profiles;
create trigger guard_consent_columns
  before update on public.profiles
  for each row execute function public.trg_guard_consent_columns();

-- Withdraw from My Profile, effective immediately.
create or replace function public.withdraw_consent(p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then raise exception 'Not logged in'; end if;
  perform set_config('app.consent_write', 'on', true);
  if p_type = 'ai' then
    update profiles set ai_consent_at = null, ai_consent_withdrawn_at = now()
    where id = (select auth.uid()) and ai_consent_at is not null;
  elsif p_type = 'location' then
    update profiles set location_consent_at = null, location_consent_withdrawn_at = now()
    where id = (select auth.uid()) and location_consent_at is not null;
  else
    raise exception 'Unknown consent type';
  end if;
  perform set_config('app.consent_write', 'off', true);
end $$;

-- Consent status for yourself, or for anyone whose sensitive details you
-- can already see (admin / finance).
create or replace function public.get_consent_status(p_profile_id uuid)
returns table (
  ai_consent_at timestamptz,
  ai_consent_withdrawn_at timestamptz,
  location_consent_at timestamptz,
  location_consent_withdrawn_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.ai_consent_at, p.ai_consent_withdrawn_at, p.location_consent_at, p.location_consent_withdrawn_at
  from profiles p
  where p.id = p_profile_id
    and (p_profile_id = (select auth.uid()) or can_view_sensitive_profile_data(p_profile_id))
$$;

-- What the logged-in person still has to sign: required policies and every
-- consent form, in their current version. Contracts go through onboarding.
create or replace function public.my_pending_documents()
returns setof uuid
language sql
stable
set search_path = public
as $$
  select d.id
  from onboarding_documents d
  where not d.is_contract
    and (d.is_required or d.consent_type is not null)
    and not exists (
      select 1 from onboarding_document_signatures s
      where s.profile_id = (select auth.uid())
        and s.document_id = d.id
        and s.document_version >= d.version
    )
  order by d.sort_order
$$;

revoke execute on function public.withdraw_consent(text) from public, anon;
revoke execute on function public.get_consent_status(uuid) from public, anon;
revoke execute on function public.my_pending_documents() from public, anon;
grant execute on function public.withdraw_consent(text) to authenticated;
grant execute on function public.get_consent_status(uuid) to authenticated;
grant execute on function public.my_pending_documents() to authenticated;
