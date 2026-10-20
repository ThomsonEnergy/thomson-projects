# CLAUDE.md

TEops: the live operations app for Thomson Energy Australia (electrical and solar). See README.md for the stack and folder layout, and `docs/` for the spec, backlog, agents plan, env vars, staging and external accounts (Twilio, Apple, Telstra, Google).

**The app is live and used on real jobs every day.** Code is the source of truth; if a doc disagrees, fix the doc.

## How the owner works

- Never use em dashes, anywhere: chat, code, comments, docs, commit messages. Use commas, colons or brackets.
- Short and concise.
- Numbers over names everywhere: J, Q, PO, SI numbers, migration numbers.
- State the plan and wait for "yes" / "let's build" before building.
- **Plan mode: name the best model and effort.** Every plan (plan mode, or any "here is the plan, yes?" reply) ends with one line: `Best model: <name>, effort <level>, because <one reason>`, and whether to switch with `/model` and `/effort <level>` before saying yes (in cloud sessions type `/effort high`, the slider does not open). Pick by the job, not the question's length:
  - Fable 5.1: anything that touches money, stock, RLS or migrations plus code in one go; whole-site review passes; a bug nobody has found the cause of; new agents. Slowest and dearest, worth it when a mistake hits live jobs.
  - Opus 5.5: the default for building features, agent changes, fixes with a known cause, and most plans.
  - Sonnet 5.5: small well-specified changes (one-file fixes, copy, `?v=` bumps), docs edits, reading logs and deploy status.
  - Haiku 5.5: lookups and yes/no checks only, never code that ships.
  - Effort: `high` for feature builds and most plans; `xhigh` or `max` only for migrations, money, stock, RLS or an unknown bug; `medium` (the Opus 5.5 default) for chat, docs and small fixes; `low` for lookups. A level saved on the laptop does not reach cloud sessions; set `CLAUDE_CODE_EFFORT_LEVEL` on the cloud environment for a standing default.
- After that "yes", carry the whole plan through without asking again: build, run production migrations, push, open the PR and merge to `main`. Only stop and ask the owner if there is a real question or a change of direction (new scope, a different migration, deleting data not in the plan, or a failure that changes the plan).
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
2. **Get it onto `main`.** Commit, push, open a PR. Docs-only PRs (`docs/`, `CLAUDE.md`, `README.md`) are merged straight away so the next chat sees them. Code and migrations wait for the owner's "yes" on the plan, then go all the way to `main` without asking again.
3. **Say so.** End the reply with one line naming the docs updated, or "no repo notes needed".

At the start of every session: pull `main` and read `docs/DECISIONS.md` before answering questions about plans or status. If the owner says something that contradicts the docs, ask, then fix the doc.

Chats that cannot write to GitHub (for example Claude Projects): end with a short "Notes for the repo" list for the owner to paste into a Claude Code session.

## Delivery standards

- `npm run check` before finishing: syntax checks every JS file, every inline HTML script block, every SQL migration, and the policy pairs below.
- Every `create policy` has a matching `drop policy if exists` right before it.
- New tables: fast RLS (`(select auth.uid())`, one policy per action), and an index on every FK. Policies are `to authenticated` unless the row is meant for the public (client pages read through token functions, never table policies).
- Every new or changed database function: `set search_path = public`; `security definer` ones check the caller (`auth.uid()`, `is_admin()`, `is_pricing_role()` or a token) and end with `revoke execute ... from public, anon` plus a `grant` only to who needs it (`authenticated`, or nobody when only the server calls it). No new `security definer` views: use `security_invoker` or a function.
- Every Netlify function checks who is calling (`requireAdmin`, `requirePricingRole`, `requireActiveUser`) unless it is public by design, in which case a random token or a verified webhook signature is the check, and the function does only what that token is for.
- Any text a person typed or that came from outside (names, notes, emails, PDFs, lead forms) goes through `escapeHtml()` before it lands in HTML, including inside `value="..."` and `data-*` attributes.
- Anything that changes money or stock (invoices, claims, credit notes, receiving, moving) runs on the server or in one database function, checks its limits there (not only in the browser), and finishes all or nothing.
- "Today" is the Sydney date (`toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })` or `sydney_today()`), never `toISOString().slice(0, 10)`.
- Verify schema dependencies exist (tables, columns, functions) instead of assuming.
- Bump the `?v=` number on every script and stylesheet reference you change (`/js` and `/css` are cached for 10 minutes).
- Compress images: static images squashed before committing; every upload goes through `compressImage()`.
- Keep the app Capacitor-ready (native iPhone wrap is planned): no web-only tricks that break inside a native WebView; anything that must work offline uses save-locally-then-sync (local queue, temp IDs, timestamps at the moment of the action).
- If something breaks after a deploy, check the Netlify deploy status and the Supabase migration status first.
- After each big chunk of features, run a whole-site review pass (read only, every area, like `docs/BUG_REVIEW.md` on 19 Oct 2026), list what it finds worst first, then fix in consolidated deliveries. The owner chose these manual passes over automatic rule checks.

## Secrets

- Never commit secrets. Env vars live in Netlify, Supabase and the Claude Code cloud environment only. Integration keys live in the `api_keys` table. See `docs/ENV_VARS.md`.
- The Supabase anon key and the VAPID public key in the code are public by design.

## Staging and production

**CURRENT MODE (from 18 Oct 2026, owner's instruction): STAGING PAUSED.** Skip staging for everything: apply migrations and push updates straight to production and merge to `main` so Netlify deploys. Still state the plan and get the owner's "yes" before building, run `npm run check`, and take a backup before risky changes. This stays until the owner says to go back to staging; then delete this paragraph and log it in `docs/DECISIONS.md`. The staging rules below are on hold until then.

- Test migrations, features and agents on the `staging` Supabase branch first, never on production data. Cloud sessions use staging credentials by default.
- Production changes (migrations, data fixes, settings) only after the owner approves.
- Supabase SQL runs without a permission popup (`.claude/settings.json` allows `execute_sql`, `list_migrations`, `list_tables`) on staging and production alike, so asking in chat is the only check: get the owner's yes before any production write. In cloud sessions (phone) that file is not enough on its own: the owner picks **Auto** in the mode dropdown next to the prompt box when starting the task (it can be switched mid-run too). In any other mode the worker stops at every Supabase call until the owner taps Allow once. If a cloud session is not in Auto, say so in the plan reply before the owner says yes. Edits to `CLAUDE.md` itself still stop for one Allow tap even in Auto; the owner is happy with that one.
- The Supabase MCP tool hangs and times out on `drop ...` statements (it waits for a confirmation it cannot show). Skip `drop ... if exists` when the object is known not to exist, send big migrations in small chunks, and record the repo's migration version in `supabase_migrations.schema_migrations` by hand. A plain `update` with long quoted text can time out the same way: wrap it in `do $$ begin ... end $$;` and it runs.
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
