# TEops (Thomson Energy operations app)

Live business app for Thomson Energy Australia: leads, quotes, jobs, scheduling, timesheets, POs, stock, invoices, STCs, HR, overheads, with Xero, Gmail, Airwallex, Formbay and web push.

**Live:** https://projects.thomsonenergy.com.au

## Stack

- **Netlify:** static front end in `public/` (no build step beyond `scripts/write-config.js`), serverless and scheduled functions in `netlify/functions/`.
- **Supabase:** Postgres, auth, storage, RLS. Schema in `supabase/migrations/`.
- **Anthropic API:** AI extraction, drafting, Sparky chat.
- **Integrations:** Xero (accounting + payroll, live), Gmail (shared sales@ inbox), Airwallex (payment links), Formbay (STCs), Pylon, Web Push. Twilio planned.

## Layout

| Path | What |
|---|---|
| `public/` | Pages (`*.html`), `js/`, `css/`, icons, PWA manifest, `sw.js` |
| `netlify/functions/` | API and scheduled functions, `_shared/` helpers |
| `tego-app/` | TEgo iPhone app (Capacitor, own `package.json`, Node 22); built by `.github/workflows/tego-ios.yml` |
| `supabase/migrations/` | Schema migrations (baseline + new changes) |
| `supabase/seed.sql` | Fake data for staging and preview branches |
| `scripts/` | `check.js` (syntax, policies, dead code, page budgets), `deadcode.js`, `page-budgets.js`, `smoke.js` (browser smoke run), `cloud-setup.sh`, `write-config.js` |
| `agents/` | `prompts/` (agent prompts, one file each) and `evals/` (real cases with the right answer) |
| `.claude/skills/` | The software factory steps: `new-feature`, `code-structure`, `prove`, `ship`, `weekly-cleanup` (`docs/SOFTWARE_FACTORY.md`) |
| `docs/` | Spec, backlog (open items only), decisions (last month), agents plan, env vars, staging; `docs/archive/` holds history: built backlog items, older decisions, finished handoffs, the old numbered migrations and `schema.sql` |
| `policies/` | Source text for onboarding documents and contracts |
| `BUGS_AND_UPDATES.md` | Auto-written by `sync-bugs-to-repo.js`, do not edit by hand |

## Getting started

```bash
bash scripts/cloud-setup.sh
```

Installs dependencies and the Supabase CLI, links to Supabase if the env vars are set, and runs `npm run check`.

## Docs

- [docs/DECISIONS.md](docs/DECISIONS.md): dated log of decisions and progress, read first (older months in `docs/archive/DECISIONS_<yyyy-mm>.md`)
- [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md): what is built and what is planned
- [docs/IDEAS_BACKLOG.md](docs/IDEAS_BACKLOG.md): open items only (built ones move to `docs/archive/IDEAS_BACKLOG_BUILT.md`, same numbers)
- [docs/AI_AGENTS_PLAN.md](docs/AI_AGENTS_PLAN.md): AI agents
- [docs/SOFTWARE_FACTORY.md](docs/SOFTWARE_FACTORY.md): how every chat builds (isolate, build, prove, ship, weekly cleanup)
- [docs/ENV_VARS.md](docs/ENV_VARS.md): env vars and keys
- [docs/STAGING.md](docs/STAGING.md): staging, migrations, backups
- [docs/BUSINESS_FACTS.md](docs/BUSINESS_FACTS.md): Xero codes, pay rates, STC pricing, perf backlog
- [docs/IOS_APP.md](docs/IOS_APP.md): TEgo iPhone app, Apple setup steps
- [docs/EXTERNAL_ACCOUNTS.md](docs/EXTERNAL_ACCOUNTS.md): Twilio, Telstra port, Apple, D-U-N-S and Google Workspace status
- [docs/GROWTH_PLAN.md](docs/GROWTH_PLAN.md): growth order and the twelve month table
- [docs/SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md](docs/SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md) and [docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md](docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md): the rules behind the quote send gate (`_shared/solar-compliance-rules.js` is distilled from them)
- [docs/HANDOFF_formbay_stc.md](docs/HANDOFF_formbay_stc.md): Formbay phases 2 to 4, still a plan
- Finished reviews, kept where code comments point at them: `docs/BUG_REVIEW.md` (19 Oct), `docs/BUG_REVIEW_2026-10-23.md`, `docs/PO_REVIEW.md`; `docs/UX_REVIEW.md` still has delivery 5 to go (backlog item 17)
- [CLAUDE.md](CLAUDE.md): rules for Claude Code
