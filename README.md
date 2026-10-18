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
| `supabase/migrations/` | Schema migrations (baseline + new changes) |
| `supabase/seed.sql` | Fake data for staging and preview branches |
| `Migrations/` | Archive of the old numbered migrations (007 to 155), history only |
| `scripts/` | `check.js` (syntax checks), `cloud-setup.sh`, `write-config.js` |
| `docs/` | Spec, backlog, agents plan, env vars, staging; `docs/archive/` for finished handoffs |
| `policies and Contracts/` | Source text for onboarding documents and contracts |
| `BUGS_AND_UPDATES.md` | Auto-written by `sync-bugs-to-repo.js`, do not edit by hand |

## Getting started

```bash
bash scripts/cloud-setup.sh
```

Installs dependencies and the Supabase CLI, links to Supabase if the env vars are set, and runs `npm run check`.

## Docs

- [docs/DECISIONS.md](docs/DECISIONS.md): dated log of decisions and progress, read first
- [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md): what is built and what is planned
- [docs/IDEAS_BACKLOG.md](docs/IDEAS_BACKLOG.md): future features
- [docs/AI_AGENTS_PLAN.md](docs/AI_AGENTS_PLAN.md): AI agents
- [docs/ENV_VARS.md](docs/ENV_VARS.md): env vars and keys
- [docs/STAGING.md](docs/STAGING.md): staging, migrations, backups
- [docs/BUSINESS_FACTS.md](docs/BUSINESS_FACTS.md): Xero codes, pay rates, STC pricing, perf backlog
- [docs/EXTERNAL_ACCOUNTS.md](docs/EXTERNAL_ACCOUNTS.md): Twilio, Telstra port, Apple, D-U-N-S and Google Workspace status
- [CLAUDE.md](CLAUDE.md): rules for Claude Code
