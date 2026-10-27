# Software factory: how every chat builds

**Status: draft 27 Oct 2026, for Fable to review, waiting on the owner's yes.** Once agreed, the short rules move into `CLAUDE.md` and each step becomes a skill in `.claude/skills/`. Backlog item 36.

## Why

Many chats build at once, on phone and laptop. Without one way of working we get:

- **Slow pages.** `public/project.html` is 696 KB in one file (next biggest: `settings.html` 182 KB). Every new job feature lands in it.
- **Dead code.** Old versions left beside new ones, functions nothing calls, scripts no page loads.
- **Features that half work.** "Check is green" only proves the code parses, not that the button does anything (for example the Generate scope of works button, broken 22 to 26 Oct 2026).
- **Chats clashing** on the same files.
- **Hard for a person to step in.** Logic buried in big pages, settings as constants in code, agent prompts written inline.

## The five steps

Every feature and fix goes through the same steps. Each is a skill so any chat (any model) runs it the same way.

| Step | Skill | What it makes sure of |
|---|---|---|
| 0. Plan | (exists) | The plan footer in `CLAUDE.md`, plus a **Done means** list |
| 1. Isolate | `/new-feature` | Its own worktree and branch, no clash with other chats |
| 2. Build | `/code-structure` | Code goes in the right place, reuses what exists, removes what it replaces |
| 3. Prove | `/prove` | It works, it is not slower, nothing dead was left |
| 4. Ship | `/ship` | PR with before and after screenshots, speed numbers, what was removed |
| 5. Look after | `/weekly-cleanup` | Weekly sweep for dead code, slow pages, unused features |

### 0. Plan

Same as today (plan footer: Touches, Overlaps, Kind, Size, Test on staging, Best model). One addition:

- **Done means:** 3 to 6 checks written as clicks a person could do ("open Q1250, step 4, press Generate scope of works, the scope fills in under 20 seconds"). These are what step 3 proves and what the PR ticks off. If a chat cannot write them, the plan is not clear enough to build.

### 1. Isolate: `/new-feature <short-name>`

1. `git fetch origin`.
2. Check Overlaps (branches not merged into `staging`, open PRs, backlog items marked "Building in"). If another branch touches the same page, stop and say "build this in that chat".
3. Make a fresh worktree: a feature from `origin/staging` on `feat/<short-name>`, a bug fix from `origin/main` on `fix/<short-name>`. Never build on `main` or `staging` directly.
   - Note for Fable: the owner's first idea was "branch from `origin/main`". The release rule from 23 Oct 2026 says features branch from `staging`. This draft keeps the release rule. Confirm.
4. Write "Building in: `feat/<short-name>`" on the backlog item, so other chats see the claim before a PR exists.

Cloud sessions are already their own copy of the repo; the worktree matters most on the laptop, where several chats share one folder.

### 2. Build: `/code-structure`

**Where code goes**

| Kind of code | Goes in | Rule |
|---|---|---|
| Page layout and page-only wiring | `public/<page>.html` | Inline script stays small (aim under 300 lines). Anything bigger is its own file. |
| A tab or panel on a big page | `public/js/<page>-<area>.js` | Loaded only when the tab opens. **`project.html` takes no new inline code**; new job tabs are their own file. |
| Browser logic used on more than one page | `public/js/<thing>.js` | One job per file. |
| API endpoint | `netlify/functions/<verb>-<noun>.js` | Thin: check the caller, read the input, call `_shared/`, answer. |
| Logic used by more than one function | `netlify/functions/_shared/` | One job per file. |
| Anything that changes money or stock | One database function | As `CLAUDE.md` already says. |
| Agent prompts and rules | `agents/prompts/<agent>.md`, settings tables | Never as long strings inside the code (the agents plan already says this, the folder was never made). |

**Rules**

- **Reuse before writing.** Search `_shared/` and `public/js/` first (`escapeHtml`, `compressImage`, Sydney date, `require-*`, `agent-log`, `push`, `calc`, `sparky-tools`). Two copies of the same logic means make it one.
- **Delete as you go.** Code that the change replaces is removed in the same PR. No commented-out code, no "v2" next to "v1". A switch to turn something off has a removal date in a comment.
- **Every file starts with a short comment:** what it does, who calls it, what tables it writes (the style most files already use).
- **New files under about 800 lines.** Past that, split by job.
- **Anything a person may want to change is data, not code:** amounts, timings, label rules, the questions Postie asks. It lives in `company_settings` or its own table with a Settings screen.
- **Same words everywhere:** the button, the table, the function and the doc use the same name for the same thing.
- **Every agent uses the same frame:** heartbeat and `agent-log`, reports to the ops manager (see `docs/AI_AGENTS_PLAN.md`), read-only first, token budget per run, eval set (step 3).

### 3. Prove: `/prove`

Run on the branch, then on the PR's Netlify deploy preview with a staging test login.

**Automatic**

1. `npm run check` (as today).
2. **Dead code check** (new `scripts/deadcode.js`): Netlify functions nothing calls and no schedule runs, `public/js` files no page loads, `_shared` exports nothing uses, `?v=` numbers out of step. Today's leftovers go in a baseline file so only *new* dead code fails; the weekly sweep works the baseline down.
3. **Page weight budget** (new `scripts/page-budgets.json`): each page's HTML plus the scripts and styles it loads. A PR that grows a page past its budget says why in the PR. `project.html` budget is today's size and only goes down.
4. **Smoke run** (Playwright, already installed in cloud sessions): open every touched page as the right test login, fail on console errors or failed network calls, record load time, click through the **Done means** steps, take screenshots at phone and desktop width, before (staging) and after (preview).
5. **Migrations:** Supabase security and performance advisors on staging after the migration runs.
6. **Agents:** every agent has `agents/evals/<agent>/` with real cases (names removed) and the right answer. A prompt or model change passes every case before it ships. First set: Postie's four misfiled emails (see the agents plan).

**Review**

7. `/code-review high` and `/simplify` on the diff, fix what they find.
8. A fresh reviewer (new subagent, not told the builder's reasoning) reads the diff against **Done means** only.

Note for Fable: points 2 and 3 are automatic checks, which backlog item 16 (19 Oct 2026) decided against. They check for dead code and speed, not code style. Owner to confirm the change.

### 4. Ship: `/ship`

1. Commit, push, open the PR into `staging` (feature) or `main` (fix), as the release rules say.
2. PR body from a new `.github/pull_request_template.md`:
   - What and why (one paragraph)
   - Done means, each ticked
   - **Before and after screenshots**, phone and desktop
   - Speed: page weight and load time, before and after
   - Removed: dead code and old versions deleted
   - Touches, Migration (yes or no, number), Docs updated
3. Screenshots go up with the PR (Fable to pick how: a `pr-assets` branch that is never merged and linked from the PR, or a GitHub upload).
4. Merge when `check` is green, by the release rules.

### 5. Look after: `/weekly-cleanup` (Fable, once a week)

- Work down the dead code baseline and page budgets, biggest first (`project.html` split into per-tab files).
- Tables and columns nothing reads (from Postgres usage stats), functions with no runs in 30 days.
- Features nobody uses (from `activity_log`), so the owner can decide keep or remove.
- Open bug reports older than a week.
- Writes a worst-first list to `docs/DECISIONS.md`, then fixes in one consolidated delivery after the owner's yes.

## Making it easy for a person to step in

- Every feature in `docs/PROJECT_SPEC.md` lists its files. A file no feature lists is a suspect for the weekly sweep.
- Small files with a header comment, settings on screens, prompts in their own files: a person can find and change one thing without reading a 700 KB page.
- Every AI action is logged and undoable (already the rule for tags).

## What to build to set this up

1. Skills: `.claude/skills/new-feature`, `code-structure`, `prove`, `ship`, `weekly-cleanup`.
2. Scripts: `scripts/deadcode.js`, `scripts/page-budgets.json` and its check, `scripts/smoke.js` (Playwright).
3. `.github/pull_request_template.md`.
4. `agents/prompts/` and `agents/evals/` folders, Postie's first eval set.
5. Rules summary into `CLAUDE.md` (Delivery standards), backlog item 16 updated.
6. First cleanup: start splitting `project.html`.

## Questions for Fable and the owner

1. Features from `staging` (current rule) or `main` (owner's first idea)?
2. Automatic dead code and page weight checks: yes (reverses item 16)?
3. Smoke run: required check on every PR, or run by the chat and reported in the PR?
4. Screenshot hosting for PRs.
5. Line limits: 300 inline, 800 per file. Right numbers?
6. Fable also has the owner's phone screenshot with more notes; add anything from it here.
