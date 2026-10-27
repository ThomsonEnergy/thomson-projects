---
name: code-structure
description: Step 2 of the software factory (Build). Where code goes in TEops, what to reuse, what to delete, and the shape every file keeps so the next chat or a person can add to it. Read before writing code on any branch.
---

# /code-structure

The full reasoning is in `docs/SOFTWARE_FACTORY.md`. This is the working list.

## Why and when in one place, how in another

- A page or Netlify function decides **when** something happens and **who** may do it (the click, the schedule, `requireAdmin`). It stays thin.
- A `netlify/functions/_shared/` or `public/js/` file owns **how** (the reusable logic). It takes plain inputs, returns a plain result (`{ ok, data, error }` or a value), and never touches the page, the HTTP response or `window`.
- One "how" serves the button, Sparky, a background worker and a test alike.

## Where code goes

| Kind of code | Goes in | Rule |
|---|---|---|
| Page layout and page-only wiring | `public/<page>.html` | Inline script under about 300 lines. Bigger goes to its own file. |
| A tab or panel on a big page | `public/js/<page>-<area>.js` | Loaded when the tab opens. **`project.html` and `settings.html` take no new inline code**: a new tab or card is its own file. |
| Browser logic used on more than one page | `public/js/<thing>.js` | One job per file. `supabase-client.js` is already too big: add nothing to it that only one page needs. |
| API endpoint | `netlify/functions/<verb>-<noun>.js` | Check the caller, read the input, call `_shared/`, answer. |
| Logic used by more than one function | `netlify/functions/_shared/<thing>.js` | One job per file. |
| Money or stock changes | One database function | As `CLAUDE.md` says: all or nothing, limits checked on the server. |
| Agent prompts and rules | `agents/prompts/<agent>.md` and settings tables | Never long strings inside code. Eval cases in `agents/evals/<agent>/`. |
| Anything a person may want to change | `company_settings` or its own table, with a Settings screen | Amounts, timings, label rules, question sets. Not constants in code. |

## Rules while writing

- **Reuse before writing.** Search `_shared/` and `public/js/` first: `escapeHtml`, `compressImage`, `sydney_today`, `require-admin`, `require-pricing-role`, `require-active-user`, `agent-log`, `push`, `calc`, `sparky-tools`, `mailboxes`, `google-client`, `xero-client`. Two copies of one piece of logic become one.
- **Delete as you go.** Code the change replaces is removed in the same PR. No commented-out code, no `v2` beside `v1`. A switch that turns something off has a removal date in its comment.
- **Header comment on every file:** what it does, who calls it, what tables it writes. Match the style of the files around it.
- **Size:** new files under about 800 lines; past that, split by job. Pages have a weight budget (`scripts/page-budgets.json`); a page over budget fails `npm run check`.
- **Same words everywhere:** the button, the table, the function and the doc use the same name for the same thing. Numbers over names (J, Q, PO, SI).
- **Bump `?v=`** on every script and stylesheet you change, on every page that loads it (the dead code check fails when pages disagree).
- **Every agent uses the same frame:** `_shared/agent-log.js` heartbeat and run log, reports to the ops manager, read-only on production until proven, a token budget per run, an eval set under `agents/evals/`.
- All the delivery standards in `CLAUDE.md` still apply (RLS, `escapeHtml`, Sydney dates, caller checks, secrets).

Then prove it with `/prove`.
