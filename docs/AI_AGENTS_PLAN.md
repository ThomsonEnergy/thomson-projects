# AI Agents Plan

Last updated 18 Oct 2026

## Goal

AI agents run as much admin as possible. Jasper directs them from his phone and only gets pulled in when needed.

## Infrastructure (fully cloud, no office hardware)

- **GitHub:** all code. **Netlify:** app and website hosting. **Supabase:** TEops data and the agents. **Google Workspace:** email, Drive, Calendar.
- **Claude API** (pay-as-you-go via Claude Console, separate from the Pro plan) powers the agents. Monthly spend caps and alerts from day one.
- Build and ship with Claude Code cloud sessions from phone or laptop. Claude Projects (TE Projects) is for planning and reads `docs/` via GitHub.

**Already live and reused:** Xero (accounting + payroll), Web Push notifications (`sw.js`, `notifications.js`, `send-notifications.js`, per-type prefs, badge), shared sales@ Gmail inbox (`sync-gmail` every 5 min), company and per-job feeds, Sparky AI chat (`ai-chat.js`), meeting transcription (`transcribe-meeting.js`, AssemblyAI).

## How agents run

- Each agent is a **Supabase Edge Function**. None exist yet; this adds a `supabase/functions/` folder.
- Prompts live as files in `agents/prompts/`, separate from logic.
- Triggered by pg_cron schedules or database webhooks (event-driven preferred). Secrets in Supabase secrets, never in code.
- Edge Functions have per-run time limits. Long jobs are split into steps, or moved to a small cloud server later if needed.
- Least privilege: each agent gets only the access its job needs.

## Worker names

Every worker has a name that says its job. The name shows in the app (for example "tagged by Tagger").

| Name | Job | Status |
|---|---|---|
| Foreman | Ops manager: runs the workers, approvals inbox, daily digest | Planned |
| Postie | Sorts every new email: spam, customer, builder, supplier, other | **Live on sales@** |
| Bouncer | Archives spam (out of the Inbox, never deleted, one-tap "Not spam") | **Live on sales@** |
| Tagger | Tags emails (later chat and SMS) to jobs: tags when sure, suggests when guessing | **Live on sales@** |
| Ghostwriter | Drafts replies for staff to check and send (never sends) | **Live on sales@** |
| Sparky | Chat assistant (Ask AI today, later @Claude in team chat) | Live (Ask AI) |
| Chaser | Quote, invoice and payment follow-ups | Planned |
| Dispatcher | Scheduling and job allocation suggestions | Planned |
| Certifier | Prepares compliance docs and certificates for the licensed signatory | Planned |
| Matcher | Matches payments to invoices and receipts | Planned |
| Weatherman | Weather-aware scheduling | Planned |

## Email workers (live on sales@, 18 Oct 2026)

- `netlify/functions/email-workers.js`, a Netlify scheduled function every minute (not a Supabase Edge Function: it reuses the Gmail and sync code already in Netlify). Prompts in `netlify/functions/_shared/email-worker-prompts.js`. Migration `20261018120000_email_workers.sql`.
- `sync-gmail` queues each new incoming email (`emails.ai_status = 'pending'`). Older mail is never processed.
- Postie (Claude Haiku 5.5) sorts it. Bouncer archives spam in TEops and Gmail, but never someone we deal with (saved client, contact or supplier), a conversation we replied in, or one tagged to a job.
- Tagger tags when the email has a J, Q or PO number, or the model is sure and the sender is that job's client. Otherwise it leaves a suggestion ("Tagger suggests J7006", Tag it or x). A conversation already tagged is left alone, so replies stay on their job.
- Ghostwriter (Claude Sonnet 5.5) drafts only for customers, builders and suppliers who ask something. Draft goes in the reply box in TEops and in Gmail Drafts, with [brackets] for facts it does not have. Sending from TEops or Gmail retires it; Discard removes it from both. Push notification type "email_draft".
- Off switch: Settings > Google Workspace (Gmail) > Email workers on. Archiving and Gmail drafts need the `gmail.modify` scope: reconnect sales@ once.
- sales@ is shared by the whole team, so the staff notice does not apply to it. Personal inboxes still wait for the notice (item 5).

## Ops manager agent (Foreman)

- Workers report to it, not to Jasper. It handles what it can within set rules and escalates the rest.
- Jasper talks to it inside TEops: a chat screen, a questions/approvals inbox, and a daily digest (done, stuck, needs me), delivered via existing Web Push.
- It **cannot** deploy, change permissions or raise spend limits. Sending email or anything with a dollar value starts as approval-required, loosened over time.
- **Phase 2:** it can request new workers by writing a GitHub issue. The Claude Code GitHub Action builds it as a PR; Jasper approves from TEops before it goes live.

## First workers (in order)

1. Email and enquiries
2. Quotes, invoices and follow-ups
3. Scheduling and job allocation (suggestions only, a human confirms)
4. Compliance docs and certificates (AI prepares, the licensed signatory reviews and signs every one)

Drafts, not sends, for the first few weeks. Later workers: payment reconciliation, weather (see docs/IDEAS_BACKLOG.md items 1 and 4).

## Email (per-user opt-in)

- Shared sales@ inbox is live. Each user **connects their own work Gmail** via one-tap Google sign-in (opt-in). Inbox screen gets a **Mine** tab beside Sales. No admin-granted access to all mailboxes; only revisit if people don't connect, and only after the staff notice.
- Agents tag emails to jobs (auto when sure, suggest when guessing, "tagged by Claude" with one-tap undo), summarise, and draft replies (in TEops and Gmail). Nothing sends without the user's click.
- **Tagged threads show on the job for everyone. Untagged emails stay private** to that user.
- Team questions about a job are answered from tagged emails, drafts and messages.
- Only users with an AI start date are processed. Full detail: docs/IDEAS_BACKLOG.md item 5.

## Team chat (replaces WhatsApp entirely, including social chat)

**Built today:** company feed and per-job feeds with posts, likes, comments and @mentions (migrations 019, 123, 124), Web Push, Sparky AI chat. **Not built:** channels, DMs, threaded replies as a chat view, Realtime delivery, offline queue.

Build on the existing feeds:
- Channels (General, Social, others) and DMs, threaded replies, photos and files to Supabase Storage (compressed), Supabase Realtime for instant delivery.
- Job tagging: type # to pick a job; tagged messages and replies show on the job page (alongside the existing job feed).
- Push is essential (already live; add chat notification types). Messages queue offline and send when signal returns.
- @Claude answers questions from the job's emails, drafts and messages (extend Sparky).
- Voice messages and Siri: docs/IDEAS_BACKLOG.md item 2.
- Rollout: test with 2 people, set a cutover date, then everything moves to the app.

## Chat agents (separate workers, both report to the ops manager)

- **Tagger:** (live on sales@ email, see Email workers) runs on every message with a small, cheap model and matches messages to jobs. Sure (explicit J number): tags immediately. Guessing: suggests a tag to confirm. All tags show "tagged by Tagger" with one-tap undo. Can retro-tag earlier messages (e.g. "what job for the downlights at m-ARTS?" then "J7006" tags both). Access: chat and jobs list only. Shared with email and SMS tagging.
- **Chat assistant (Sparky):** wakes only on @Claude or a question it can answer. Smarter model, read access to job emails, drafts and notes. Answers instantly from TEops (e.g. which J number to clock into).
- **Social channel:** Claude reads it only to spot and tag work talk. It never summarises, reports on or stores personal chat. This goes in the staff notice.

## Consent

- **NSW Workplace Surveillance Act 2005:** written notice (generally 14 days) plus a computer surveillance policy before AI reading of email, chat or voice starts. Adviser review first. One notice covers email, chat, voice, SMS and location.
- Staff sign in TEops with a versioned re-sign and two tick boxes (AI features, location). AI start date per user = sign date if ticked, else none. Users with no AI start date are excluded from all agent processing; manual tagging still works.
- Onboarding signing (migration 098) already exists and is extended for this. Full detail: docs/IDEAS_BACKLOG.md item 6.

## Safety

- **Staging first:** a Supabase persistent branch with fake data. Every agent, migration and prompt change is tested there before production.
- **Read-only on production until proven:** new agents start with read access only, then drafts, then approval-required actions, then limited autonomy.
- **Spend caps:** Claude Console monthly limit and alerts from day one; per-agent token budget per run; the ops manager cannot raise limits.
- No agent can deploy, change permissions, move money (Airwallex key is read-only) or send without approval until explicitly loosened.
- Every agent action logged (agent, input, output, cost) and visible in TEops.
