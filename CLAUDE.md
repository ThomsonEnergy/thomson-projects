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
- **Every plan ends with the same footer** (plan mode, or any "here is the plan, yes?" reply), so the owner can tell which chat to build in and what the release will need:
  - `Touches:` every page, script, function and migration the build will change, by file name, the big shared ones first (`project.html`, `supabase-client.js`, `settings.html`, `style.css`).
  - `Overlaps:` other work on the same files, or "none". Check three places first: `git fetch origin` then branches not yet merged into `staging` (`git branch -r --no-merged origin/staging`), the open PRs on GitHub, and items in `docs/IDEAS_BACKLOG.md` marked "waiting on yes". If there is an overlap, say "build this in that chat" with the PR number or branch name.
  - `Kind:` bug fix (straight into `main`) or feature (into `staging`); migration yes or no; money, stock, RLS or payroll yes or no (then a backup before the production migration).
  - `Size:` small (under an hour), medium (a morning) or large (a day or more).
  - `Test on staging:` which login to use and the three or four clicks that show it working; anything that needs a key on the staging site (AI, Xero, Gmail).
  - `Best model: <name>, effort <level>, because <one reason>` (the line described above).
  The same `Touches:` line goes in the `docs/IDEAS_BACKLOG.md` item when the plan is written up, so other chats can see the overlap before a branch exists.
- After that "yes", carry the whole plan through without asking again: build, push, open the PR. A bug fix then goes all the way (production migration, merge to `main`); a feature merges into `staging` once it is whole and waits there for release night (see "Releases" below). Only stop and ask the owner if there is a real question or a change of direction (new scope, a different migration, deleting data not in the plan, or a failure that changes the plan).
- One consolidated delivery, not lots of small ones.
- Talk plainly, one step at a time: say exactly what to click and what they should see, especially in dashboards (Netlify, Supabase, Twilio, Apple, Google). No "see line 6 of seed.sql": test-only staging logins can be stated in chat directly. Real keys and passwords never go in chat.
- Owner is also the bookkeeper (does Xero payroll). Give Xero steps directly, never "ask your bookkeeper". Xero entity is Thomson Energy Australia only, never Thomson Energy Solutions, and use the real account codes (see `docs/BUSINESS_FACTS.md`).

## Working across devices (phone and laptop)

The owner switches between Claude Code on the laptop and cloud sessions on the phone. Cloud sessions only see GitHub, and the laptop's local Claude memory does not travel. So:

- **GitHub is the only shared memory.** Anything worth remembering (rules, decisions, account progress, business facts) goes in this file or `docs/`, never only in local memory or chat.
- **Never leave work only on one device.** Before ending a turn that changed files: commit, push, and open (or update) a PR. Merge it (features into `staging`, bug fixes and docs into `main`) once the owner approves, so the next session on any device starts from it.
- **Start of every session:** pull the latest `main` (or sync the worktree with the base branch) before working, and check open PRs/branches from the other device.
- Decisions and progress from planning chats go in `docs/` the same day (for example `docs/EXTERNAL_ACCOUNTS.md`).

## Keep every chat in the loop (every chat, no exceptions)

Other chats only know what is on `main`. So in every session, before the final reply:

1. **Write it back.** Anything finished, decided, added as an idea, or changed in scope (including talk-only planning chats with no code) goes in the repo:
   - one dated line at the top of `docs/DECISIONS.md` saying what changed and where the detail lives;
   - the detail in the right doc: `docs/PROJECT_SPEC.md` (built or in scope), `docs/IDEAS_BACKLOG.md` (ideas and plans), `docs/AI_AGENTS_PLAN.md` (agents), `docs/EXTERNAL_ACCOUNTS.md` (outside accounts), `docs/BUSINESS_FACTS.md` (business facts).
2. **Get it onto `main`.** Commit, push, open a PR. Docs-only PRs (`docs/`, `CLAUDE.md`, `README.md`) are merged straight away so the next chat sees them. Code and migrations wait for the owner's "yes" on the plan; bug fixes then go all the way to `main` without asking again, features merge into `staging` and wait there for release night (see "Releases").
3. **Say so.** End the reply with one line naming the docs updated, or "no repo notes needed".

At the start of every session: pull `main` and read `docs/DECISIONS.md` before answering questions about plans or status. If the owner says something that contradicts the docs, ask, then fix the doc.

Chats that cannot write to GitHub (for example Claude Projects): end with a short "Notes for the repo" list for the owner to paste into a Claude Code session.

## Releases (owner's rule from 23 Oct 2026)

- **Two branches matter.** `main` is the live site. `staging` is the next release: the staging database follows it and Netlify builds it at https://staging--thomsonprojects.netlify.app (staging database, test logins in `docs/STAGING.md`). Everything is tested there, together, before it goes live.
- **Bug fixes** (something live is wrong): branch off `main`, `npm run check`, PR into `main`, merge straight away, any time of day. A migration in a fix still gets the owner's yes first and goes to production before the merge. Then merge `main` into `staging` (a merge commit) so the fix is on the test site too.
- **Features and updates**: branch off `staging`, one branch and one PR per feature, PR into `staging`. Merge into `staging` as soon as the feature is whole and `check` is green, any time of day (nothing on `staging` is live). The staging database runs the feature's migrations by itself when the PR merges. Half-built work stays on its own branch and its own preview link; a feature that is on `staging` but not ready on release night holds up the whole release until a chat reverts it out, so merge only what is finished.
- **Release** (overnight or end of week, when the owner says "release"): one PR `staging` into `main`. The release chat applies every new migration to production (`supabase db push` linked to production), merges with a merge commit (never squash, so `main` and `staging` stay identical), confirms the Netlify deploy commit matches `main`, and tells the owner what went live. The one exception: the owner says at the start of the chat "upload this straight to the site" (then it is handled like a bug fix).
- **Weekends (owner's rule from 24 Oct 2026):** nobody is on the app on a Saturday or Sunday (Sydney), so a finished build goes straight live when the owner says go: production migration, PR into `main`, merge, confirm the deploy. No staging wait. Weekday builds still go through `staging`.
- Features that touch the same page or depend on each other: one chat, one branch, one after the other. Parallel chats are for separate areas (quotes, stock, inbox).
- The GitHub Action `check` runs `npm run check` on every PR and is a required check on `main`: wait for the green tick before merging. Nobody approves anything by hand.
- Docs-only PRs still go straight into `main`, then `main` into `staging`.

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

- Test migrations, features and agents on the `staging` Supabase branch first, never on production data. Cloud sessions use staging credentials by default.
- Production changes (migrations, data fixes, settings) only after the owner approves.
- Supabase SQL runs without a permission popup (`.claude/settings.json` allows `execute_sql`, `list_migrations`, `list_tables`) on staging and production alike, so asking in chat is the only check: get the owner's yes before any production write. In cloud sessions (phone) that file is not enough on its own: the owner picks **Auto** in the mode dropdown next to the prompt box when starting the task (it can be switched mid-run too). In any other mode the worker stops at every Supabase call until the owner taps Allow once. If a cloud session is not in Auto, say so in the plan reply before the owner says yes. Edits to `CLAUDE.md` itself still stop for one Allow tap even in Auto; the owner is happy with that one.
- The Supabase MCP tool hangs and times out on `drop ...` statements (it waits for a confirmation it cannot show). Skip `drop ... if exists` when the object is known not to exist, send big migrations in small chunks, and record the repo's migration version in `supabase_migrations.schema_migrations` by hand. A plain `update` with long quoted text can time out the same way: wrap it in `do $$ begin ... end $$;` and it runs.
- New AI agents start read-only on production until proven.

## Migrations

1. `supabase migration new <name>` (files go in `supabase/migrations/`, never the old `Migrations/` archive).
2. Write the SQL, run `npm run check`.
3. Show the owner the SQL and wait for "yes".
4. Apply to staging: merging the feature PR into `staging` runs it on the staging database by itself (or `supabase db push` linked to staging to test earlier on the PR preview). Test there.
5. At release time (a bug fix: straight after the owner's yes): `supabase db push` linked to production, then merge `staging` into `main` (a bug fix: its PR into `main`) so Netlify deploys. Confirm both succeeded. (Supabase "Deploy to production" is off on purpose.)
6. Risky changes (dropping columns or tables, bulk updates): take a backup first.

Full detail in `docs/STAGING.md`.

## Docs

Update `docs/PROJECT_SPEC.md`, `docs/IDEAS_BACKLOG.md` and `docs/AI_AGENTS_PLAN.md` in the same change whenever a decision changes or a feature ships. Do not edit `BUGS_AND_UPDATES.md` by hand (it is written by `sync-bugs-to-repo.js`).
