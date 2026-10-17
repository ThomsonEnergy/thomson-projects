-- Explicit Data API grants, matching production.
--
-- Production was created when Supabase still granted anon, authenticated and
-- service_role full table/sequence/function access by default. New projects
-- (and so every staging and preview branch) no longer do, which left those
-- roles with no SELECT/INSERT/UPDATE/DELETE at all after the baseline.
-- RLS policies are what actually limit access; these grants just let the
-- policies apply. On production this changes nothing (every grant below
-- already exists there).

-- Tables and views: full DML for the three API roles, except table-level
-- SELECT on profiles for anon/authenticated (they only get the column-level
-- SELECT grants from the baseline, so sensitive columns stay hidden).
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
  loop
    execute format('grant insert, update, delete on public.%I to anon, authenticated, service_role', r.relname);
    execute format('grant select on public.%I to service_role', r.relname);
    if r.relname <> 'profiles' then
      execute format('grant select on public.%I to anon, authenticated', r.relname);
    end if;
  end loop;
end $$;

grant usage, select, update on all sequences in schema public to anon, authenticated, service_role;

-- Same defaults as production for anything created later.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete, truncate, references, trigger on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select, update on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
