# CLAUDE.md

TEops: the live operations app for Thomson Energy Australia (electrical and solar). See README.md for the stack and folder layout, and `docs/` for the spec, backlog, agents plan, env vars, staging and external accounts (Twilio, Apple, Telstra, Google).

**The app is live and used on real jobs every day.** Code is the source of truth; if a doc disagrees, fix the doc.

## How the owner works

- Never use em dashes, anywhere: chat, code, comments, docs, commit messages. Use commas, colons or brackets.
- Short and concise.
- Numbers over names everywhere: J, Q, PO, SI numbers, migration numbers.
- State the plan and wait for "yes" / "let's build" before building.
- One consolidated delivery, not lots of small ones.
- Talk plainly, one step at a time: say exactly what to click and what they should see, especially in dashboards (Netlify, Supabase, Twilio, Apple, Google). No "see line 6 of seed.sql": test-only staging logins can be stated in chat directly. Real keys and passwords never go in chat.
- Owner is also the bookkeeper (does Xero payroll). Give Xero steps directly, never "ask your bookkeeper". Xero entity is Thomson Energy Australia only, never Thomson Energy Solutions, and use the real account codes (see `docs/BUSINESS_FACTS.md`).

## Working across devices (phone and laptop)

The owner switches between Claude Code on the laptop and cloud sessions on the phone. Cloud sessions only see GitHub, and the laptop's local Claude memory does not travel. So:

- **GitHub is the only shared memory.** Anything worth remembering (rules, decisions, account progress, business facts) goes in this file or `docs/`, never only in local memory or chat.
- **Never leave work only on one device.** Before ending a turn that changed files: commit, push, and open (or update) a PR. Merge to `main` once the owner approves, so the next session on any device starts from it.
- **Start of every session:** pull the latest `main` (or sync the worktree with the base branch) before working, and check open PRs/branches from the other device.
- Decisions and progress from planning chats go in `docs/` the same day (for example `docs/EXTERNAL_ACCOUNTS.md`).

## Keep every chat in the loop (every chat, no exceptions)

Other chats only know what is on `main`. So in every session, before the final reply:

1. **Write it back.** Anything finished, decided, added as an idea, or changed in scope (including talk-only planning chats with no code) goes in the repo:
   - one dated line at the top of `docs/DECISIONS.md` saying what changed and where the detail lives;
   - the detail in the right doc: `docs/PROJECT_SPEC.md` (built or in scope), `docs/IDEAS_BACKLOG.md` (ideas and plans), `docs/AI_AGENTS_PLAN.md` (agents), `docs/EXTERNAL_ACCOUNTS.md` (outside accounts), `docs/BUSINESS_FACTS.md` (business facts).
2. **Get it onto `main`.** Commit, push, open a PR. Docs-only PRs (`docs/`, `CLAUDE.md`, `README.md`) are merged straight away so the next chat sees them. Code and migrations still wait for the owner's "yes".
3. **Say so.** End the reply with one line naming the docs updated, or "no repo notes needed".

At the start of every session: pull `main` and read `docs/DECISIONS.md` before answering questions about plans or status. If the owner says something that contradicts the docs, ask, then fix the doc.

Chats that cannot write to GitHub (for example Claude Projects): end with a short "Notes for the repo" list for the owner to paste into a Claude Code session.

## Delivery standards

- `npm run check` before finishing: syntax checks every JS file, every inline HTML script block, every SQL migration, and the policy pairs below.
- Every `create policy` has a matching `drop policy if exists` right before it.
- New tables: fast RLS (`(select auth.uid())`, one policy per action), and an index on every FK.
- Verify schema dependencies exist (tables, columns, functions) instead of assuming.
- Bump the `?v=` number on every script and stylesheet reference you change (`/js` and `/css` are cached for 10 minutes).
- Compress images: static images squashed before committing; every upload goes through `compressImage()`.
- Keep the app Capacitor-ready (native iPhone wrap is planned): no web-only tricks that break inside a native WebView; anything that must work offline uses save-locally-then-sync (local queue, temp IDs, timestamps at the moment of the action).
- If something breaks after a deploy, check the Netlify deploy status and the Supabase migration status first.

## Secrets

- Never commit secrets. Env vars live in Netlify, Supabase and the Claude Code cloud environment only. Integration keys live in the `api_keys` table. See `docs/ENV_VARS.md`.
- The Supabase anon key and the VAPID public key in the code are public by design.

## Staging and production

**CURRENT MODE (from 18 Oct 2026, owner's instruction): STAGING PAUSED.** Skip staging for everything: apply migrations and push updates straight to production and merge to `main` so Netlify deploys. Still state the plan and get the owner's "yes" before building, run `npm run check`, and take a backup before risky changes. This stays until the owner says to go back to staging; then delete this paragraph and log it in `docs/DECISIONS.md`. The staging rules below are on hold until then.

- Test migrations, features and agents on the `staging` Supabase branch first, never on production data. Cloud sessions use staging credentials by default.
- Production changes (migrations, data fixes, settings) only after the owner approves.
- Supabase SQL runs without a permission popup (`.claude/settings.json` allows `execute_sql`, `list_migrations`, `list_tables`) on staging and production alike, so asking in chat is the only check: get the owner's yes before any production write.
- The Supabase MCP tool hangs and times out on `drop ...` statements (it waits for a confirmation it cannot show). Skip `drop ... if exists` when the object is known not to exist, send big migrations in small chunks, and record the repo's migration version in `supabase_migrations.schema_migrations` by hand.
- New AI agents start read-only on production until proven.

## Migrations

1. `supabase migration new <name>` (files go in `supabase/migrations/`, never the old `Migrations/` archive).
2. Write the SQL, run `npm run check`.
3. Show the owner the SQL and wait for "yes".
4. Apply to staging (`supabase db push` with the CLI linked to staging), test. (Skipped while staging is paused, see above.)
5. After the owner says yes: `supabase db push` linked to production, then merge to `main` so Netlify deploys. Confirm both succeeded. (Supabase "Deploy to production" is off on purpose.)
6. Risky changes (dropping columns or tables, bulk updates): take a backup first.

Full detail in `docs/STAGING.md`.

## Docs

Update `docs/PROJECT_SPEC.md`, `docs/IDEAS_BACKLOG.md` and `docs/AI_AGENTS_PLAN.md` in the same change whenever a decision changes or a feature ships. Do not edit `BUGS_AND_UPDATES.md` by hand (it is written by `sync-bugs-to-repo.js`).
