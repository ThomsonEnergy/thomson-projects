# Staging, migrations and backups

TEops is live. Everything is tested on staging first.

## How it fits together

- **Production:** Supabase project `ziakpklnzkbbjjnqgkmz` + the Netlify production deploy from `main`.
- **Staging:** a persistent Supabase branch called `staging` (ref `jpmaudhhsahjhnrufzez`, https://jpmaudhhsahjhnrufzez.supabase.co), following the `staging` git branch, built from `supabase/migrations/` and seeded with fake data from `supabase/seed.sql`. Netlify branch deploys and deploy previews point at it (set 18 Oct 2026, see `docs/ENV_VARS.md`).
- **Preview branches (optional):** with the GitHub integration on, each pull request gets a throwaway Supabase branch that runs the PR's migrations. It is deleted when the PR closes.
- **Production migrations:** NOT automatic ("Deploy to production" is off, so the repo can never change live auth settings or the live schema by itself). After the owner approves, Claude runs `supabase db push` linked to production, then the PR is merged and Netlify deploys the code.

## One-time setup (owner, in the dashboards)

Do these in order. Steps 1 to 3 must be finished before step 4, or the integration will try to run the baseline against production.

1. **Merge the cloud-prep PR** (adds `supabase/migrations/<ts>_baseline.sql`, `supabase/config.toml`, `supabase/seed.sql`).
2. **Repair production migration history** (Claude does this after your yes): mark the ~95 old history entries as reverted and the baseline as applied, so production history = the repo. This only edits the `supabase_migrations.schema_migrations` table, no schema or data changes. The old entries are kept in the repo under `Migrations/`.
3. **Check `supabase/config.toml` [auth] against production** (Dashboard > Authentication > URL configuration and Sign in providers): site URL, redirect URLs, sign-ups on/off. Branching can push config.toml settings to production, so they must match before turning it on.
4. **Enable branching:** Dashboard > Project settings > Integrations > GitHub: connect `ThomsonEnergy/thomson-projects`, Supabase directory `supabase`, production branch `main`. Turn on "Automatic branching" (per-PR previews). Leave "Deploy to production" OFF.
5. **Create the persistent staging branch:** Dashboard > Branches > Create branch `staging`, mark it persistent. Note its project ref, URL, anon key and service role key.
6. **Netlify:** Site settings > Environment variables: for "Branch deploys" and "Deploy previews" set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` to the staging branch values. Enable branch deploys for a `staging` git branch if you want a fixed staging URL.
7. **Supabase Auth on staging:** add the Netlify preview URL pattern to its redirect URLs, and create test logins (fake staff, one per role).
8. **Claude Code cloud env:** add `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` (staging ref), `SUPABASE_DB_PASSWORD` (staging).

Cost: Pro plan branch compute, roughly US$10/month for the persistent staging branch, plus a little per preview branch while a PR is open.

## Migration workflow

1. New file: `supabase migration new <name>` (creates `supabase/migrations/<timestamp>_<name>.sql`).
2. Every `create policy` has `drop policy if exists` right before it. Index every FK. Fast RLS (`(select auth.uid())`, one policy per action).
3. `npm run check` (parses the SQL and checks the policy pairs).
4. Show the owner the SQL. Wait for "yes".
5. Apply to staging (`supabase db push` linked to staging, or let the PR preview branch run it). Test.
6. Production: after the owner says yes, `supabase db push` linked to production (`SUPABASE_PROJECT_REF=ziakpklnzkbbjjnqgkmz`), then merge to `main` so Netlify deploys the code.
7. Confirm `supabase migration list` shows it applied on production, and the Netlify deploy is published.
8. Risky changes (dropping columns or tables, bulk updates): take a backup first (Dashboard > Database > Backups, or `supabase db dump --data-only` for the affected tables).

If something breaks after a deploy: check the Netlify deploy status and the Supabase migration status first.

## Backup restore test (owner to run once, then yearly)

Proves the daily backups actually work.

1. Dashboard > Database > Backups: note the latest daily backup time.
2. Restore it into a **new temporary project** (Backups > Restore to new project), never into production or the staging branch.
3. On the new project check: row counts for `projects`, `quotes`, `invoices`, `time_entries` roughly match production; log in works; a quote page loads (point a local copy at it or query in the SQL editor).
4. Write the date and result at the bottom of this file.
5. Delete the temporary project.

Last restore test: not yet run.
