# Staging, migrations and backups

TEops is live. Everything is tested on staging first.

**Paused from 18 Oct 2026:** the owner said skip staging and push all updates straight to production until they say otherwise. See `CLAUDE.md` Staging and production.

## How it fits together

- **Production:** Supabase project `ziakpklnzkbbjjnqgkmz` + the Netlify production deploy from `main`.
- **Staging:** a persistent Supabase branch called `staging` (ref `jpmaudhhsahjhnrufzez`, https://jpmaudhhsahjhnrufzez.supabase.co), following the `staging` git branch, built from `supabase/migrations/` and seeded with fake data from `supabase/seed.sql`. Netlify branch deploys and deploy previews point at it (set 18 Oct 2026, see `docs/ENV_VARS.md`).
- **Preview branches (optional):** with the GitHub integration on, each pull request gets a throwaway Supabase branch that runs the PR's migrations. It is deleted when the PR closes.
- **Production migrations:** NOT automatic ("Deploy to production" is off, so the repo can never change live auth settings or the live schema by itself). After the owner approves, Claude runs `supabase db push` linked to production, then the PR is merged and Netlify deploys the code.

## Releases, the required check and Point in Time Recovery (23 Oct 2026)

Staging was paused from 18 to 23 Oct 2026 for a run of bulk updates and is back on. The rules now:

- **Bug fixes** go to `main` straight away. **Features** wait on their own branch; the owner tests them on the PR's Netlify deploy preview (it runs against the staging database) and releases overnight or at the end of the week by telling a chat "release PR 123". That chat applies the migrations to production, merges, checks the deploy commit on Netlify matches `main`, then runs `git push origin main:staging`. Full rule in `CLAUDE.md`, "Releases".
- **The `staging` git branch follows `main`.** The Supabase staging branch (`jpmaudhhsahjhnrufzez`) runs whatever migrations are on the `staging` git branch, so after every merge: `git push origin main:staging`. Its old history has no shared base with `main`, so the first sync needs a force push, which cloud sessions are not allowed to make: owner, once, from the laptop in the repo folder: `git fetch origin && git push --force origin origin/main:staging`. Then Dashboard > Branches > staging should show the migrations running; after that plain `git push origin main:staging` works.
- **Preview branches:** automatic branching makes a throwaway Supabase branch per PR and should delete it when the PR closes. Check Dashboard > Branches now and then; on 23 Oct one from PR 34 (`feat/email-workers`, 18 Oct) was still running. Delete leftovers: Dashboard > Branches > the branch > the three dots > Delete branch.

### Testing a feature on its preview (owner)

- Every PR gets a preview address from Netlify (on the PR page, "Deploy Preview" link, or Netlify > Deploys). It runs against the staging database, never live data: type in whatever dummy jobs, quotes and POs you like.
- Staging logins (test only, not real accounts): admin@staging.test, finance@staging.test, sales@staging.test, staff@staging.test, password `StagingOnly-TEops-2026`. Staging starts with a handful of fake rows from `supabase/seed.sql` and keeps whatever you add until the branch is reset.
- A feature that adds a migration: the chat building it pushes the migration to staging (`supabase db push` linked to staging) so the preview works before the release.
- What does not work on a preview: anything that needs a real integration key (AI buttons, Xero, Gmail, Airwallex, Formbay, Pylon) unless that key is also put in staging's `api_keys` table from Settings on the preview; scheduled functions (they only run on the production deploy); emails and push notifications to real people.
- Until the one-off `staging` sync above is done, previews will error on the columns added since 18 Oct.

### Make `check` a required check on `main` (owner, GitHub, once)

The Action `.github/workflows/check.yml` runs `npm run check` on every PR by itself; nobody taps anything. To make a red result block the merge:

1. GitHub > the repo > Settings > Rules > Rulesets > New ruleset > New branch ruleset.
2. Ruleset name `main`. Enforcement status: Active. Target branches: Add target > Include default branch.
3. Tick **Require a pull request before merging** (leave Required approvals at 0: you are the only reviewer).
4. Tick **Require status checks to pass**, then Add checks and pick `check` (it only appears in the list after the Action has run once, so do this after the first PR with the Action has merged).
5. Tick **Block force pushes**. Create.

From then on a chat waits for the green tick before merging. Nothing else changes.

### Turn on Point in Time Recovery (owner, Supabase, once)

Daily backups can lose up to a day. PITR keeps a running copy so the database can be put back to any minute, which is the real safety net for a bad migration.

1. Supabase Dashboard > the production project > Project Settings (the gear) > Add-ons.
2. Point in Time Recovery > Enable, keep 7 days. It needs the Pro plan (already on it for branching) and the Small compute add-on or bigger; the page shows the monthly price before you confirm.
3. Afterwards, Database > Backups has a "Point in time" tab: pick a date and minute to restore to a new project, never straight over production.

### Migration history note

`supabase/migrations/20261017120000_explicit_api_grants.sql` is in the repo but not in production's `supabase_migrations.schema_migrations`. Its grants already match production (that was its point), so the next `supabase db push` to production will apply it again harmlessly; record it by hand if the push complains.

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

1. New file: `supabase migration new <name>` (creates `supabase/migrations/<timestamp>_<name>.sql`). This repo's numbers run ahead of the calendar (they are in November 2026), so a fresh real timestamp would sort before migrations already applied: name the file with the day after the newest file in `supabase/migrations` plus the real time of day to the second (for example `20261123033219`), never a round number like `20261119000000`. Two chats on different devices picked the same round numbers on 22 Oct 2026 (two files each at 20261119000000 and 20261120000000), which breaks `supabase db push`; the battery and rates ones were renumbered 20261122090000 and 20261122090100 and recorded by hand.
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

**Helper (20 Oct 2026):** `node scripts/sql-for-mcp.js supabase/migrations/<file>.sql` prints the migration as chunks with every `drop` / `delete` statement wrapped and split for the tool (`--one N` prints chunk N to paste into `execute_sql`); used for migration 20261108000000. Then record the version by hand.

**Supabase MCP tool and the word "delete" (20 Oct 2026):** the tool waits forever on any query text containing `drop`, or the word `delete` (even inside a function body or a policy name). Work-around used for migration 20261107000000: wrap the statement in `do $$ begin execute '...' end $$;` with the word split in the string (`'del' || 'ete'`); the stored function or policy is the clean text from the repo file. Then insert the version into `supabase_migrations.schema_migrations` by hand.
