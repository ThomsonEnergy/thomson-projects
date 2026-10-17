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

- Test migrations, features and agents on the `staging` Supabase branch first, never on production data. Cloud sessions use staging credentials by default.
- Production changes (migrations, data fixes, settings) only after the owner approves.
- New AI agents start read-only on production until proven.

## Migrations

1. `supabase migration new <name>` (files go in `supabase/migrations/`, never the old `Migrations/` archive).
2. Write the SQL, run `npm run check`.
3. Show the owner the SQL and wait for "yes".
4. Apply to staging (`supabase db push` with the CLI linked to staging), test.
5. After the owner says yes: `supabase db push` linked to production, then merge to `main` so Netlify deploys. Confirm both succeeded. (Supabase "Deploy to production" is off on purpose.)
6. Risky changes (dropping columns or tables, bulk updates): take a backup first.

Full detail in `docs/STAGING.md`.

## Docs

Update `docs/PROJECT_SPEC.md`, `docs/IDEAS_BACKLOG.md` and `docs/AI_AGENTS_PLAN.md` in the same change whenever a decision changes or a feature ships. Do not edit `BUGS_AND_UPDATES.md` by hand (it is written by `sync-bugs-to-repo.js`).
