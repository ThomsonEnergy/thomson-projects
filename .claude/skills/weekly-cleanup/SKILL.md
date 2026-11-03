---
name: weekly-cleanup
description: Step 5 of the software factory (Look after). A weekly read-only sweep for dead code, pages over or near budget, unused tables and functions, and features nobody uses, written up worst first for the owner's yes before any fix. Run once a week, or when the owner asks.
---

# /weekly-cleanup

Read only until the owner says yes to the list. One consolidated fix PR after that.

## Sweep

1. **Dead code baseline:** `node scripts/deadcode.js`. Every line still in `scripts/deadcode-baseline.json` is a candidate: confirm it is unused (search the name across the repo, `netlify.toml`, the Supabase schema for triggers that call functions, and `docs/`), then list it for deletion. Cleared lines come out of the baseline.
2. **Page budgets:** `node scripts/page-budgets.js --list`. The top pages, biggest first, with what to move out next (a tab of `project.html` into `public/js/project-<tab>.js`, loaded when the tab opens; parts of `supabase-client.js` that only one page needs). Each move is one PR through the factory.
3. **Database:** on staging (read only), tables and columns nothing reads (`pg_stat_user_tables` seq and idx scans, plus a search of the code for the name), functions with no calls in the code, policies on tables that are gone.
4. **Functions with no runs:** `agent_runs` and `agent_heartbeats` for workers silent for 30 days; scheduled functions in `netlify.toml` whose work is done.
5. **Features nobody uses:** `activity_log` and page visits over the last 30 days against the feature list in `docs/PROJECT_SPEC.md`. The owner decides keep or remove.
6. **Open bug reports** older than a week (`bug_reports`), and PRs older than a week.
7. **Docs drift:** files no feature in `docs/PROJECT_SPEC.md` names; spec items that say "planned" for something that is built.

## Report

A dated section at the top of `docs/DECISIONS.md` ("Weekly cleanup <date>"), worst first, each line with the fix and its size. End with the plan footer from `CLAUDE.md` (Touches, Overlaps, Kind, Size, Test on staging, Best model) for the fix PR, and wait for the yes.

## Fix

After the yes: one branch through `/new-feature`, `/code-structure`, `/prove`, `/ship`. Deleting a table or column: backup first, as `CLAUDE.md` says.
