# Environment variables and keys

Names only. Values never go in the repo, in chat, or in a commit.

## Netlify (Site settings > Environment variables)

| Name | What it's for | Contexts |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL used by functions | Production: live. Branch deploys / previews: staging branch URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin access for functions (bypasses RLS) | Production: live. Branch deploys / previews: staging branch key |
| `SUPABASE_ANON_KEY` | Public anon key. Optional in production (falls back to the live key in code). In other contexts it is required: `scripts/write-config.js` swaps it into the browser build and functions use it | Branch deploys / previews: staging branch anon key |
| `DEV_MODE_PASSWORD` | Unlocks Dev Mode (`verify-dev-mode.js`) | All |
| `CLAUDE_AGENT_KEY` | Lets Claude agents post comments on bugs (`add-agent-comment.js`) | All |
| `GITHUB_TOKEN` | Writes `BUGS_AND_UPDATES.md` to the repo (`sync-bugs-to-repo.js`) | Production |
| `SERVICEM8_API_KEY` | Legacy SM8 functions and the SM8 import fallback | Production |
| `PDF_KEEP_BROWSER` | Optional PDF function tuning flag | Optional |
| `URL`, `DEPLOY_URL`, `CONTEXT` | Set by Netlify automatically | Automatic |

**Staging rule:** branch deploys and deploy previews must have the three `SUPABASE_*` values set to the staging branch, or they will read and write live data. Scheduled functions only run on the production deploy.

## Supabase `api_keys` table (Settings page in TEops, admin only)

Integration credentials live in the database, not env vars, read through `getIntegrationKey()` (`netlify/functions/_shared/get-integration-key.js`). A `<NAME>_API_KEY` env var is only a fallback.

Keys: `anthropic`, `assemblyai`, `abr_guid`, `servicem8`, `pylon`, `xero_client_id`, `xero_client_secret`, `xero_webhook_key`, `google_client_id`, `google_client_secret`, `google_refresh_token`, `google_history_id`, `google_oauth_pending_state`, `airwallex_api_key`, `airwallex_client_id`, `airwallex_webhook_secret`, `formbay`, `formbay_username`, `formbay_password`, `formbay_webhook_secret`, `vapid_public_key`, `vapid_private_key`.

The staging branch starts with an empty `api_keys` table, so Xero, Gmail, Airwallex, Formbay and push do nothing there. That is deliberate: staging can never email a customer or post to the live Xero. Add sandbox keys to staging only when testing that integration.

Future (not built): Twilio (`twilio_account_sid`, `twilio_auth_token`, `twilio_number`), speech-to-text provider, weather API.

## Claude Code cloud environment (claude.ai/code > environment settings)

| Name | What it's for |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI login (personal access token from supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_REF` | Project the CLI links to. **Default to the staging branch ref.** Use the live ref `ziakpklnzkbbjjnqgkmz` only for an approved production migration |
| `SUPABASE_DB_PASSWORD` | Database password for the linked project |

`scripts/cloud-setup.sh` uses all three to link the CLI. Without them it still installs everything and runs `npm run check`.
