# Migrations archive (history only)

**Do not add files here or run these.** Since 17 Oct 2026 the schema lives in `supabase/migrations/`: a baseline taken from the live database plus every change after it. See `docs/STAGING.md` for the workflow.

This folder keeps the old numbered files (007 to 155, some numbers used twice) for history. `recovered/` holds 4 migrations that were applied to the live database but never saved here, copied back from the live migration history. `migration_audit_diagnostic.sql` was the old check for which files had been run.

Original notes below.

---

# Thomson Projects, All Migrations

Every migration for this project, migration_001 through the highest-numbered
file in this folder, in run order. migration_007 through migration_043 were
reconstructed from what had already been applied directly in Supabase, since
nothing in this app runs a migration automatically and several changes were
made straight in the SQL Editor with no file ever committed for them.
migration_044 onward continues from there in the order it actually happened.

## Run order

Run these in numeric order. Each is safe to re-run if something fails partway
through, every policy has a matching `drop policy if exists` guard, so
re-running a migration that already partially applied won't error out on
duplicate policies.

## Checking what's actually been run

`migration_audit_diagnostic.sql` is read-only, run it any time in Supabase's
SQL Editor to see which migrations show real evidence of having been applied
to your live database, versus which are just sitting in this folder unrun.
This checks your actual schema, not your GitHub files, so it catches
migrations that exist in the repo but were never executed. Keep it in sync
when you add a new migration - one more `union all` row checking for
something that migration's SQL actually created.

## If you're setting these up in a fresh GitHub repo / Claude Code session

Recommended folder: `migrations/` in your repo root, one file each, kept in
this same numbered order. That numbering is meaningful, later migrations
sometimes depend on columns/tables an earlier one created.
