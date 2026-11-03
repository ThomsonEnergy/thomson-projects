---
name: prove
description: Step 3 of the software factory (Prove). Show the change works, is not slower, and left nothing dead, with before and after evidence from a real browser. Run on every branch before /ship.
---

# /prove

Evidence, not "it should work". Everything here goes in the PR.

## 1. Before, first

Capture the **before** state while it is cheap, before changing code where possible (a bug fix: reproduce it on staging and keep the screenshot or output).

```
node scripts/smoke.js --base https://staging--thomsonprojects.netlify.app --login <role> \
  --pages <touched pages, comma separated> --label before --out smoke/before
```

`<role>` is `admin`, `finance`, `sales` or `staff` (staging test accounts, `docs/STAGING.md`). `smoke/` is git-ignored.

## 2. Automatic checks

- `npm run check`: syntax, policy pairs, **dead code** (new findings only, baseline in `scripts/deadcode-baseline.json`) and **page budgets** (`scripts/page-budgets.json`). A page over budget: make it smaller (move code to a per-tab file) or, with a reason the PR states, raise its budget. `project.html` and `settings.html` budgets never go up.
- A finding you cleared from the baseline: remove its line from `scripts/deadcode-baseline.json` in the same PR.
- Migrations: after the PR preview's Supabase branch has run them, read the security and performance advisors on that branch and fix what they flag.
- Agents: a prompt or model change runs every case in `agents/evals/<agent>/` and passes them all before it ships (see `agents/evals/README.md`).

## 3. After, on the preview

Push the branch, wait for the Netlify deploy preview link on the PR (`https://deploy-preview-<n>--thomsonprojects.netlify.app`), then:

```
node scripts/smoke.js --base <preview url> --login <role> --pages <same pages> \
  --label after --out smoke/after --steps scripts/steps/<short-name>.js
node scripts/smoke.js --compare smoke/before smoke/after > smoke/table.md
```

`scripts/steps/<short-name>.js` is the plan's **Done means** as code: `module.exports = async (page, { base, shot }) => { ... }` using Playwright's `page` (click, fill, expect text) and `shot('name')` after each step. Keep it to the clicks in the plan. A failing step fails the run. Delete the steps file in the PR unless it is worth keeping as a lasting check (then move it to `scripts/steps/keep/`).

The run fails on a page error or a failed same-origin call. Console errors and third-party failures are listed: look at each, fix the ones your change caused.

## 4. Review loop

1. `/code-review high` on the diff, then `/simplify`. Fix what they find.
2. Run them again. Stop when a pass finds nothing, or after 3 rounds: leftovers go in the PR under "known".
3. A fresh reviewer: `Agent` (general-purpose) given only the diff and the Done means list, not your reasoning, asked whether each Done means item is met by the code. Fix what it finds.

## 5. Plain words

Last pass over anything a person reads (commit message, PR title and body, button and message text, docs): no em dashes, no filler words, say what changed and why, in the owner's style (`CLAUDE.md`, "How the owner works"). Numbers over names.

Then `/ship`.
