-- Two related changes:
--
-- 1. Pay rates (profiles.ordinary_rate/rate_1_5x/rate_2x/rate_2_5x) should
--    only be readable by admin/finance, or by the person they belong to -
--    not by every role that can now see the profiles table broadly since
--    migration_059. Same masked-view pattern migration_007 already used
--    for cost_centres pricing columns: a secure view that nulls the
--    column out unless the caller is allowed to see it, plus revoking the
--    raw columns from `authenticated` on the base table so the view can't
--    be bypassed by querying profiles directly. Netlify functions using
--    the service-role client are unaffected either way - REVOKE only
--    applies to the `authenticated` role browsers use.
--
-- 2. Self-service profile fields - bank account details, so every user
--    can add their own without an admin doing it for them. (Photo, mobile
--    number, and licences are already writable by a user on their own row
--    - "Users can update own profile" from migration_007 already allows
--    it, and migration_058 opened up viewing/managing licences broadly;
--    this just adds an explicit self-manage policy for profile_licences
--    in case write access there was still narrower than that.)

create or replace function can_view_pay_rates(p_profile_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select coalesce(
    (select role from profiles where id = auth.uid()) in ('admin', 'finance')
    or auth.uid() = p_profile_id,
    false
  );
$$;

drop view if exists profiles_pay_rates_secure;
create view profiles_pay_rates_secure
with (security_invoker = false) as
select
  id,
  case when can_view_pay_rates(id) then ordinary_rate else null end as ordinary_rate,
  case when can_view_pay_rates(id) then rate_1_5x else null end as rate_1_5x,
  case when can_view_pay_rates(id) then rate_2x else null end as rate_2x,
  case when can_view_pay_rates(id) then rate_2_5x else null end as rate_2_5x
from profiles;

grant select on profiles_pay_rates_secure to authenticated;

revoke select (ordinary_rate, rate_1_5x, rate_2x, rate_2_5x) on profiles from authenticated;

alter table profiles add column if not exists bank_account_name text;
alter table profiles add column if not exists bank_bsb text;
alter table profiles add column if not exists bank_account_number text;

alter table profile_licences enable row level security;
drop policy if exists "staff can manage own licences" on profile_licences;
create policy "staff can manage own licences"
  on profile_licences for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());
