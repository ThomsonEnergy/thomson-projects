# Thomson Projects — All Migrations

Every migration from this build, migration_007 through migration_043, in run order.
(001-006 predate this chat's visibility — already applied, not included here.)

## Run order

Run these in numeric order (007, 008, 009... 043). Each is safe to re-run if
something fails partway through — every policy has a matching `drop policy
if exists` guard, so re-running a migration that already partially applied
won't error out on duplicate policies.

## Checking what's actually been run

`migration_audit_diagnostic.sql` is read-only — run it any time in Supabase's
SQL Editor to see which of these 37 migrations show real evidence of having
been applied to your live database, versus which are just sitting in this
folder unrun. This checks your actual schema, not your GitHub files, so it
catches migrations that exist in the repo but were never executed.

## If you're setting these up in a fresh GitHub repo / Claude Code session

Recommended folder: `migrations/` in your repo root, one file each, kept in
this same numbered order. That numbering is meaningful — later migrations
sometimes depend on columns/tables an earlier one created.
