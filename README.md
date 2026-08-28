# Thomson Projects — All Migrations

Every migration for this project, migration_001 through the highest-numbered
file in this folder, in run order. migration_007 through migration_043 were
reconstructed from what had already been applied directly in Supabase, since
nothing in this app runs a migration automatically and several changes were
made straight in the SQL Editor with no file ever committed for them.
migration_044 onward continues from there in the order it actually happened.

## Run order

Run these in numeric order. Each is safe to re-run if something fails partway
through — every policy has a matching `drop policy if exists` guard, so
re-running a migration that already partially applied won't error out on
duplicate policies.

## Checking what's actually been run

`migration_audit_diagnostic.sql` is read-only — run it any time in Supabase's
SQL Editor to see which migrations show real evidence of having been applied
to your live database, versus which are just sitting in this folder unrun.
This checks your actual schema, not your GitHub files, so it catches
migrations that exist in the repo but were never executed. Keep it in sync
when you add a new migration - one more `union all` row checking for
something that migration's SQL actually created.

## If you're setting these up in a fresh GitHub repo / Claude Code session

Recommended folder: `migrations/` in your repo root, one file each, kept in
this same numbered order. That numbering is meaningful — later migrations
sometimes depend on columns/tables an earlier one created.
