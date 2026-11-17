-- Bug fix, 18 Nov 2026 (owner: "permission denied for table profiles", logged in as admin).
-- profiles is read column by column (baseline: revoke select, then grant select on a list of
-- columns), and the job plan's profiles.on_tools (migration 20261207000000) came with no grant, so
-- every page that read it (Schedule > Plan, the quote's When card, Plan settings) was refused.
-- npm run check now fails a new profiles or cost_centres column that has no select grant.
grant select (on_tools) on public.profiles to authenticated;
