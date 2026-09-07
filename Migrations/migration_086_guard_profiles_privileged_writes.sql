-- Migration 086 — CRITICAL: close a privilege-escalation gap on profiles
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- The same class of bug fixed for SELECT in migration 079 (a blanket
-- table-level grant defeats any column-level restriction) was never
-- applied to UPDATE. Verified directly: as an ordinary authenticated
-- user, `update profiles set role = 'admin' where id = <own id>`
-- succeeds - the RLS policy "Users can update own profile" only checks
-- WHICH ROW (auth.uid() = id), never which COLUMNS or VALUES, and the
-- default Supabase table-wide UPDATE grant to authenticated (and even
-- anon) has no column restriction at all. Any logged-in staff member can
-- self-promote to admin, reactivate/deactivate themselves, or set their
-- own pay rate directly from the browser console.
--
-- Separately, "Finance can update any profile" (migration_062) was only
-- ever meant to let finance edit someone ELSE's job_title (team.html) -
-- but the policy has no column scoping either, so it actually grants
-- finance unrestricted write access to every column on every profile,
-- including role and pay rates.
--
-- Column-level GRANTs can't express "admin can change X but self can't"
-- (grants aren't row/condition-aware - they apply to the whole
-- `authenticated` role regardless of which RLS policy let the row
-- through), so this is enforced with a BEFORE UPDATE trigger instead,
-- which CAN see both old/new values and who's asking.
--
-- Deliberately bypassed when auth.uid() is null - that's a service-role
-- call from a Netlify function (create-user-with-password.js,
-- invite-user.js, the active-toggle endpoint, sync-employee-to-xero.js,
-- etc.), already access-controlled at the application layer before ever
-- reaching Postgres. This trigger only needs to guard direct
-- client-side writes using a real user's own session - exactly the
-- vector proven exploitable above.
--
-- TFN/date_of_birth/bank details/super fund info are deliberately NOT in
-- the blocked list - onboarding.html legitimately self-writes those via
-- this exact "own row" path, and that's correct (an employee providing
-- their own TFN/bank details at onboarding, not an employer-set fact).

create or replace function guard_profiles_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- service-role call from a Netlify function - already gated at the application layer
  end if;

  if is_admin() then
    return new;
  end if;

  if current_profile_role() = 'finance' and old.id <> auth.uid() then
    if (to_jsonb(new) - 'job_title') is distinct from (to_jsonb(old) - 'job_title') then
      raise exception 'Finance can only update job_title on another employee''s profile.';
    end if;
    return new;
  end if;

  -- Employer-set facts - never directly self-editable, by anyone but an
  -- admin, on ANY row (including your own).
  if new.role is distinct from old.role
    or new.active is distinct from old.active
    or new.ordinary_rate is distinct from old.ordinary_rate
    or new.rate_1_5x is distinct from old.rate_1_5x
    or new.rate_2x is distinct from old.rate_2x
    or new.rate_2_5x is distinct from old.rate_2_5x
    or new.annual_salary is distinct from old.annual_salary
    or new.rate_tier_id is distinct from old.rate_tier_id
    or new.employment_type is distinct from old.employment_type
    or new.pay_type is distinct from old.pay_type
    or new.employment_start_date is distinct from old.employment_start_date
  then
    raise exception 'Only an admin can change role, active status, pay rates, or employment classification.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profiles_writes on profiles;
create trigger trg_guard_profiles_writes
  before update on profiles
  for each row execute function guard_profiles_writes();
