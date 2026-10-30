# AI Agents Plan

Last updated 17 Oct 2026

## Goal

AI agents run as much admin as possible. Jasper directs them from his phone and only gets pulled in when needed.

## Infrastructure (fully cloud, no office hardware)

- **GitHub:** all code. **Netlify:** app and website hosting. **Supabase:** TEops data and the agents. **Google Workspace:** email, Drive, Calendar.
- **Claude API** (pay-as-you-go via Claude Console, separate from the Pro plan) powers the agents. Monthly spend caps and alerts from day one.
- Build and ship with Claude Code cloud sessions from phone or laptop. Claude Projects (TE Projects) is for planning and reads `docs/` via GitHub.

**Already live and reused:** Xero (accounting + payroll), Web Push notifications (`sw.js`, `notifications.js`, `send-notifications.js`, per-type prefs, badge), shared sales@ Gmail inbox (`sync-gmail` every 5 min), company and per-job feeds, Sparky AI chat (`ai-chat.js`), meeting transcription (`transcribe-meeting.js`, AssemblyAI), Knowledge Base reader (`read-knowledge-background.js`, `read-knowledge-sweep.js` every 2 minutes, spec A32).

## How agents run

- Agents run as **Netlify functions** (decided 18 Oct 2026, instead of Supabase Edge Functions, so there is one place to look when something breaks). Long work runs as background functions (up to 15 minutes). Every worker reports through `_shared/agent-log.js`.
- Prompts live as files in `agents/prompts/`, separate from logic.
- Triggered by pg_cron schedules or database webhooks (event-driven preferred). Secrets in Supabase secrets, never in code.
- Edge Functions have per-run time limits. Long jobs are split into steps, or moved to a small cloud server later if needed.
- Least privilege: each agent gets only the access its job needs.

## Ops manager agent

**Version 1 built 18 Oct 2026** (`docs/PROJECT_SPEC.md` A30): worker log, Needs me list, 5am Sydney digest to Jasper only (more people later via `company_settings.ops_manager_user_ids`), Ops manager page, and the assistant acts as the manager in chat with Confirm-only actions. Not yet: Phase 2 (requesting new workers via GitHub issues), per-agent token budgets.


- Workers report to it, not to Jasper. It handles what it can within set rules and escalates the rest.
- Jasper talks to it inside TEops: a chat screen, a questions/approvals inbox, and a daily digest (done, stuck, needs me), delivered via existing Web Push.
- It **cannot** deploy, change permissions or raise spend limits. Sending email or anything with a dollar value starts as approval-required, loosened over time.
- **Phase 2:** it can request new workers by writing a GitHub issue. The Claude Code GitHub Action builds it as a PR; Jasper approves from TEops before it goes live.

## First workers (in order)

1. Email and enquiries
2. Quotes, invoices and follow-ups
3. Scheduling and job allocation (suggestions only, a human confirms)
4. Compliance docs and certificates (AI prepares, the licensed signatory reviews and signs every one)

Already built: **price list reader** (emailed price lists keep material costs current, `docs/PROJECT_SPEC.md` A11b), **supplier bill intake** (invoice@ emails read, matched to POs, suggest-only until proven; `docs/PROJECT_SPEC.md` A11a).

Also built: **licence and insurance expiry** (nightly, `sweep-licence-expiry.js`, reminders only; `docs/PROJECT_SPEC.md` B3).

Drafts, not sends, for the first few weeks. Later workers: payment reconciliation, weather (see docs/IDEAS_BACKLOG.md items 1 and 4).

## Email (per-user opt-in)

- Shared sales@ inbox is live. Each user **connects their own work Gmail** via one-tap Google sign-in (opt-in). Inbox screen gets a **Mine** tab beside Sales. No admin-granted access to all mailboxes; only revisit if people don't connect, and only after the staff notice.
- Agents tag emails to jobs (auto when sure, suggest when guessing, "tagged by Claude" with one-tap undo), summarise, and draft replies (in TEops and Gmail). Nothing sends without the user's click.
- **Tagged threads show on the job for everyone. Untagged emails stay private** to that user.
- Team questions about a job are answered from tagged emails, drafts and messages.
- Built 18 Oct 2026 (spec A18): email agent sorts Priority / Other / Subscriptions and updates, applies labels, tags jobs, drafts Priority replies, suggests per-sender clean up. Haiku 5.5 sorts, Opus 5.5 drafts. Runs in `mailbox-work-background.js`, reports to the ops manager as "Postie: email agent". 19 Oct 2026: Postie also spots supplier invoices sent to sales@, passes them to the bill reader (**Tally**) and drafts a "please use invoice@" reply; Tally drafts "invoice@ is for invoices only" replies (spec A11a). 19 Oct 2026: Postie drafts in the mailbox owner's own voice (style guide learned from their sent replies, Settings > Email Agent) and answers instead of recapping the sender (spec A18). Company voice (jasper@) is the default for every mailbox, each can switch to its own. Spell check (Haiku 5.5) and Polish (Sonnet 5.5) on every multi-line text box (spec A33). 20 Oct 2026: label sweeps (a new label or changed description makes Postie file the inbox's last 60 days under it), labels made by Postie itself when a mailbox's auto_labels switch is on (duplicate guard, AI tag), and who-has-it on every conversation (replied by, claimed, assigned; the assignee alone gets the new-mail notification) with a Tagged to jobs view (spec A18). A 7am leads reminder (`remind-leads.js`, no AI, 30 Oct 2026): Admin, Finance and Sales hear once a day about each lead still new after 48 hours and each website call request past its time (spec A28). A 7am booking reminder (`remind-client-bookings.js`, no AI): whoever booked a job starting within 3 days with the client not told gets a phone notification (spec A34).
- A personal mailbox is processed only once its owner connected it, after the Gmail notice (agree and waive the 14 days, or 14 days after the notice). Full detail: docs/IDEAS_BACKLOG.md item 5.

## Team chat (replaces WhatsApp entirely, including social chat)

**Live 18 Oct 2026:** channels, DMs, threads, photos, files, voice messages, # job tags, Realtime, instant push, offline queue, plus the tagger, voice transcripts and @Sparky in chat. Detail: `docs/PROJECT_SPEC.md` A19a. **Not built:** Siri Shortcut (backlog item 2), Sparky answering questions without being @mentioned (left out on purpose to keep it quiet), editable vocabulary list.

Build on the existing feeds:
- Channels (General, Social, others) and DMs, threaded replies, photos and files to Supabase Storage (compressed), Supabase Realtime for instant delivery.
- Job tagging: type # to pick a job; tagged messages and replies show on the job page (alongside the existing job feed).
- Push is essential (already live; add chat notification types). Messages queue offline and send when signal returns.
- @Claude answers questions from the job's emails, drafts and messages (extend Sparky).
- Voice messages and Siri: docs/IDEAS_BACKLOG.md item 2.
- Rollout: test with 2 people, set a cutover date, then everything moves to the app.

## Chat agents (separate workers, both report to the ops manager)

- **Tagger:** runs on every message with a small, cheap model and matches messages to jobs. Sure (explicit J number): tags immediately. Guessing: suggests a tag to confirm. All tags show "tagged by Claude" with one-tap undo. Can retro-tag earlier messages (e.g. "what job for the downlights at m-ARTS?" then "J7006" tags both). Access: chat and jobs list only. Shared with email and SMS tagging.
- **Chat assistant:** wakes only on @Claude or a question it can answer. Smarter model, read access to job emails, drafts and notes. Answers instantly from TEops (e.g. which J number to clock into).
- **Social channel:** Claude reads it only to spot and tag work talk. It never summarises, reports on or stores personal chat. This goes in the staff notice.

## Consent

- **NSW Workplace Surveillance Act 2005:** written notice (generally 14 days) plus a computer surveillance policy before AI reading of email, chat or voice starts. Adviser review first. One notice covers email, chat, voice, SMS and location.
- Staff sign in TEops with a versioned re-sign and two tick boxes (AI features, location). AI start date per user = sign date if ticked, else none. Users with no AI start date are excluded from all agent processing; manual tagging still works.
- Built: versioned re-sign and AI / location consent with dates per user (migration 20261018120000, `profiles.ai_consent_at`). Every agent must skip users with no `ai_consent_at`, and anything before the notice start date, except team chat: Sparky is a member of every chat (channels and DMs), so chat needs no AI consent (owner's lawyer, 18 Oct 2026). Staff who don't want Sparky involved text outside the app. Full detail: docs/IDEAS_BACKLOG.md item 6.

## Retail plan suggestions (built 23 Oct 2026)

Suggests electricity plans for a quote's address from the AER's Consumer Data Right plan data (downloaded daily by `sync-energy-plans`, listed on the ops manager's workers), costed with the savings estimate's own maths, not an AI web search; staff choose what goes on the proposal and nothing is sent automatically. Writes only its own `energy_plans` table. Wholesale-price plans are not estimated (the app says so); a proper wholesale estimate is backlogged as item 35. Detail in `docs/IDEAS_BACKLOG.md` item 34.

## Proposed 27 Oct 2026: one brain, many workers (waiting on the owner's yes, backlog item 37)

### How it works today (from the code, 27 Oct 2026)

- **Sparky** is the chat brain: the Ask AI widget (`ai-chat-background.js`) and @Sparky in team chat (`_shared/chat-ai.js`). It answers with a read-only `query_database` tool that runs under the asking person's login (RLS applies), plus the Knowledge Base, a calculator and web search.
- **The ops manager is not a separate AI.** It is Sparky with an extra paragraph of instructions for admins (the worker tables, Needs me, three Confirm actions), plus the 5am `ops-digest.js` and the Ops page.
- **Workers** (Postie, Tally, price list reader, Knowledge reader, sweeps) each run on their own schedule. They do not talk to each other, except Postie handing invoices to Tally. Anything they cannot finish lands in `agent_tasks` (Needs me) for a person.
- **Dark corners:** Sparky can only query a hand-kept list of about 50 of the roughly 130 tables (`_shared/sparky-tools.js` `QUERYABLE_TABLES`). Ask AI cannot see emails or chat at all (only @Sparky in chat can), and newer tables (energy plans, email labels, notifications, job contacts) are missing because nobody added them to the list.

### Answers to the owner's questions

- **Sparky and the ops manager: one brain, one name.** Two names for one model with different instructions confuses people. Keep the specialist workers separate (they run in the background on cheap models with narrow access, which is safer and cheaper), but everything a person talks to is the one assistant.
- **One ops manager or one each: both, as two views of the same brain.** The company view (admins) sees everything and decides who is needed where. The personal view (each person, sales and above) is the same brain limited to what that person can see, ranking their work and booking their day (My Plan, below). The company view feeds the personal ones: when it assigns something, it shows up in that person's plan.
- **Where to give the agents information** (best first):
  1. **Corrections in place:** undo a tag, move an email to the right label, edit a draft before sending. Captured automatically, so it is the cheapest teacher (needs the learning loops below).
  2. **Rules on Settings screens:** label descriptions, Postie's question sets per enquiry type, what we already know about a client.
  3. **Knowledge Base:** company procedures, product sheets, pricing rules.
  4. **Prebuild library with clear descriptions:** the AI quotes from prebuilds, so good names and descriptions there mean better draft quotes.

### What to build

1. **See everywhere.** Replace the hand-kept table list with a registry: every table has a one-line Postgres comment saying what it holds, and is marked visible to the assistant or hidden (passwords, keys, tokens). `npm run check` fails when a new table is neither, so no dark corner can appear again. RLS still decides what each person's assistant sees. Ask AI also gets the page and record the person is looking at.
2. **Workers report events, the ops manager routes them.** New `agent_events` (type, from which worker, job, quote, supplier or email it relates to, one-line summary) and a routing table (event type to: a person or role, a job task, a tag, or another worker). Examples: subscription renewal failed goes to Finance; licence renewal notice goes to the licence register and Finance; a supplier's reply on a job waiting for it ticks that job task. Unknown event types go to Needs me and the ops manager suggests a route for the owner to approve, so routes grow without building a workflow per agent.
3. **Job tasks that wait on an email.** A job task can say what it waits on (supplier, email address or domain, PO or quote number). When Postie sees a matching email it tags the thread to the job, marks the task "reply received" and tells the task's owner. No extra drafts.
4. **Postie learns from edits.** When a Postie draft is sent after a person changed it, the draft and the sent text are kept as a pair. Weekly, Sonnet turns the differences into short lessons in the mailbox's style notes (Settings > Email Agent, editable). Today `learn-writing-style.js` only learns from sent replies in general, not from what people change in Postie's drafts.
5. **Postie files emails better** (built 27 Oct 2026, on `staging`, first feature through the software factory; spec A18). Checked on production 27 Oct 2026: 4 of the 8 emails Postie put under the "GCW dispute" label do not belong there (two about a staff member's workers compensation case, a battery recall notice, a panel clean photo). Cause: Haiku sorts and labels in one pass, there are only two labels, and `auto_labels` is off on sales@, so when an email looked "legal" and no label fitted, it picked the nearest one instead of none. Fix: labels chosen by Sonnet in a second pass only for emails that might fit one; it must quote the words in the email that match the label's description, or choose none; when unsure it suggests (one tap to accept) instead of applying; moving or removing a label becomes an eval case. Those four emails are the first eval set (`agents/evals/postie/`, 6 cases with a runner). Built: Haiku's sort now only flags "could fit a label"; Sonnet picks the label with quoted evidence (`agents/prompts/postie-labels.js`, the first prompt out of the code); the label sweep uses the same rule. Not yet: a removed or moved label becoming an eval case by itself (needs a small table and an inbox change), and the 4 wrong labels on production still need removing (owner's yes).
6. **Emails to the right person.** Postie's sort also picks who must act (from the job's contacts, the role, past replies) and assigns the thread, so the action shows in that person's plan.
7. **My Plan page (sales and above).** A personal to-do list and an hour-by-hour office calendar (like Motion): emails to answer, quotes ready for approval, DNSP applications, calls, job tasks. The assistant ranks them by urgency and due date and books them into free hours; site work stays on the main schedule and shows here as blocked time. It adds job tasks when it spots them in emails and chat (marked "added by Sparky", one-tap undo). Google Calendar sync later.
8. **Automation spotter.** Weekly, the ops manager reads `activity_log` for things people do by hand again and again and suggests automations as backlog items for the owner to approve.
9. **Enquiry to draft quote.** One pipeline, a question set per enquiry type (data on a Settings screen, not code):
   - Battery: bill, switchboard photo, solar size and install year. Reads the bill (bill reader exists), checks export is enough, checks the switchboard photo for RCDs, adds the battery and any RCD prebuilds, scope of works with the "RCDs found on site are extra" disclaimer, savings from the existing calculator.
   - New build: thanks the builder, asks timeline, start date, build length. Reads the plans: counts GPOs and lights, floor area, estimates cable from area and point count, adds prebuilds, flags what is missing (main switchboard or meter board not shown, no lighting plan).
   - Solar: reads the bill, suggests a system size, prices and scopes it; sales still does the Pylon design and checks the roof.
   - Electrical (switchboard upgrade): asks for a switchboard photo, counts circuits, quotes from prebuilds.
   - Every type: **never asks what we already know** (lead form, client record, past jobs, files already sent). The finished draft quote goes into the sales team's My Plan as "Ready for approval"; a person always checks and sends.
   - Rollout: Postie's question emails start as drafts a person sends. Auto reply is switched on per enquiry type only after its questions are approved without edits for a set number of weeks.

Order: 5 and 1 first (fix filing, see everywhere), then 2 and 3, 4, 6 and 7, then 9 one enquiry type at a time (battery first, the bill reader and quote steps already exist), 8 last.

## Safety

- **Staging first:** a Supabase persistent branch with fake data. Every agent, migration and prompt change is tested there before production.
- **Read-only on production until proven:** new agents start with read access only, then drafts, then approval-required actions, then limited autonomy.
- **Spend caps:** Claude Console monthly limit and alerts from day one; per-agent token budget per run; the ops manager cannot raise limits.
- No agent can deploy, change permissions, move money (Airwallex key is read-only) or send without approval until explicitly loosened.
- Every agent action logged (agent, input, output, cost) and visible in TEops.
