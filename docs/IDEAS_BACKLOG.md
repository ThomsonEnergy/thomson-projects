# TEops Ideas Backlog

Last updated 21 Oct 2026 (quote workflow plan, item 24)

Planned work not yet in docs/PROJECT_SPEC.md Part A. Code is the source of truth: if something here is built, move it to the spec.

## Status

| # | Item | Status | High lead time | Depends on |
|---|------|--------|----------------|------------|
| 1 | Payment reconciliation, receipts, tools register | Partly built | N | Airwallex read-only key, accountant sign-off |
| 2 | Voice messages in team chat + Siri Shortcut | Voice messages built with team chat (PROJECT_SPEC A19a), Siri not started | N | Personal tokens for the Siri Shortcut |
| 3 | Native iPhone app (TEgo, Capacitor) | Stage 1 built, waiting on Apple | Y | Apple Developer enrolment approval, then `docs/IOS_APP.md` setup; offline sync design for stage 2 |
| 4 | Weather-aware scheduling worker | Not started | N | Job lat/long (not stored today), work type field |
| 5 | Per-user inboxes with job tagging | Built 18 Oct 2026 (spec A18), on staging | N | Per-user Gmail OAuth, tagger agent, staff notice |
| 6 | Policy sign-off, AI consent, location tracking | Partly built | Y | Adviser review of notice, 14 days' notice, job lat/long |
| 7 | SMS and calls via Twilio | Not started | Y | Native app (3), Telstra port (Twilio bundle approved) |
| 8 | invoice@ supplier bill intake agent | Live 18 Oct 2026, suggest-only for 2 weeks | N | Owner checks matches, then auto-save on |
| 9 | Staff policy set (gaps and fixes) | Planned, waiting on owner's pick | N | Adviser review (Formby or HR), then load into onboarding documents |
| 22 | PO, bills, stock from My Day, tools register (review and 4-delivery plan) | Built 20 Oct 2026, all four LIVE (spec A10, A11c, A12, A12a) | N | Airwallex payouts still to build (needs the payout key) |
| 10 | Purchase order upgrades (stock PO, move unused lines, undo received, open/closed, email PO PDF) | Built 19 Oct 2026, LIVE (spec A10) | N | None |
| 15 | Security sweep and hardening | Planned: last step, once major additions stop | N | Build sequence finished |
| 17 | User-friendliness upgrades (whole-app review) | Owner said build all 168 in six deliveries; deliveries 1 to 4 (items 1 to 109) LIVE 19 to 20 Oct 2026, next delivery 5 (`docs/UX_REVIEW.md`) | N | None |
| 18 | Knowledge Base background reader (server OCR, per-page search for Sparky) | Built 19 Oct 2026, LIVE (spec A32) | N | None |
| 24 | Gather first, generate last: pre-quote information, Battery proposals, send gate | Built 21 Oct 2026, LIVE (spec A3), migration 20261115000000 | N | Owner to record SAA GCBS (battery) accreditation under Team with "battery" in the licence name |
| 25 | AI guesses prebuild components and prebuilds per cost centre (highlighted to check) | Built 21 Oct 2026, LIVE (spec A3), migration 20261116000000 | N | None |
| 26 | STCs and BSTCs separate | Folded into item 27 (credits at quote level, not per stage) | N | See 27 |
| 27 | Quote in steps: create, pre-quote info, site visit, pricing, scope of works, send; STC and BSTC credits at quote level | Planned 21 Oct 2026, waiting on owner's yes | N | None |

## High lead time, start now

Live progress (D-U-N-S, Apple, Twilio, Telstra, Google Workspace) is tracked in `docs/EXTERNAL_ACCOUNTS.md`.

- **Apple Developer organisation account:** D-U-N-S received 17 Oct 2026; enrolment submitted 17 Oct, Apple is verifying. Blocks item 3, and so item 7.
- **Twilio:** Business Profile and AU Mobile bundle approved 18 Oct 2026, test number active. Next: port 0455 415 464 from Telstra once the build is tested. Item 7 is built after the native app.
- **NSW surveillance notice:** get the notice and policy reviewed by Formby or an HR adviser, then 14 days' written notice before AI reading or tracking starts. Blocks AI on chat, email, voice and location (items 2, 5, 6).
- **Google OAuth app:** internal Google Workspace app, no Google verification needed, so this is fast. The shared inbox already uses one; per-user Gmail scopes are an extension.

---

## 1. Payment reconciliation, receipts and tools register

**Goal:** TEops does the thinking on reconciliation so Jade's Xero work becomes a quick review; tools and equipment stop getting lost as material purchases.

**Decision: keep Xero.** Xero (LIVE for accounting and payroll) stays the compliance engine: ledger, payroll/STP, super, BAS, accountant access, bank feeds. TEops runs operations and pushes clean data into Xero.

**Built today:** Xero invoice, credit note, timesheet and pay rate pushes; Airwallex webhook (handles `payment_link.paid` only); supplier statement reconciliation; Formbay payment advice import; supplier invoice extraction.

### Payment reconciliation agent
- Reads incoming Airwallex deposits via API (daily or webhook). **Read-only key**, can never move money.
- Matches deposits to invoices: SI number in the reference first, then amount + client name.
- Confident match: marks invoice paid in TEops. Guess, part payment or odd amount: goes to the approval inbox (e.g. "$4,180 from J Smith, looks like SI3042, short $20. Match?").
- Matches outgoing Airwallex supplier payments to supplier bills in TEops.
- Pushes each matched payment to Xero against the invoice or bill, so the bank line shows a pre-suggested match.
- **Known limit:** Xero's API cannot press the final "OK" on bank reconcile. Jade taps OK down pre-matched lines and handles exceptions (fees, refunds, split payments, anything not in TEops).
- **Overdue notices only after reconciliation is checked:** re-pull deposits, check the unmatched queue for that client, hold and ask if doubtful. Reminders start as drafts for approval.
- **Before building:** run the plan past Jade and the accountant so it fits month-end close.

### Receipts page (non-job spending)
- Snap a photo; AI extracts supplier, date, amount, GST, category (mapped to real Xero account codes).
- Auto-matches the bank/card line, pushes to Xero coded so it is pre-matched.
- Image stored against the record (ATO: generally 5 years). Review before save, like all AI extraction.
- Image compressed via `compressImage()` on upload.

### Tools and equipment register
- **Built 20 Oct 2026** as `tools.html` (spec A12a): register with location (Warehouse or vehicle), status, serial / photo / receipt rule over $500, Tools POs and tool lines on any PO, By vehicle view for perishables. Still to come from the list below: AI flagging on bills, test and tag reminders, Xero fixed asset push.
- Fields: item, serial number, purchase date, cost, supplier, assigned to (person or vehicle), location, warranty expiry.
- **AI flagging on supplier bills:** tool-like lines (drill, test instrument) flagged "move to assets instead of materials?", accept or deny, never automatic. Extends supplier invoice extraction.
- **Compliance:** test and tag and calibration due dates, with reminders before they lapse.
- Push to Xero fixed asset register so the accountant handles depreciation / instant asset write-off.

**Open questions**
- [ ] Does our Xero plan include auto-reconcile features?
- [ ] Jade/accountant sign-off on the workflow and month-end process
- [ ] Asset capitalisation threshold (accountant)
- [ ] Should assets assigned to a vehicle link to `fleet.html` vehicle records? (probably yes)

---

## 2. Voice messages in team chat + Siri Shortcut

**Goal:** Siri dictation in WhatsApp mangles job numbers, names and trade terms; some staff dictate while driving. Part of the team chat build (docs/AI_AGENTS_PLAN.md). iPhone only.

**Reuse:** `meeting-recorder.js` (browser recording) and `transcribe-meeting.js` (AssemblyAI; key already in `api_keys`).

**Built 18 Oct 2026 with team chat (PROJECT_SPEC A19a):** tap the mic to record, tap Send. The audio sends straight away and the cleaned transcript appears under it a few seconds later (no review-before-send step, so it also works with no signal). Job numbers in the transcript are tagged like any message. Not built: the editable vocabulary list (staff names and trade words are boosted automatically) and Siri.

### In-app voice messages (hold to talk)
- Mic button in chat: hold, talk, release.
- Speech to text (AssemblyAI to start), then a Claude cleanup pass with TEops context: job numbers, clients, site addresses, staff, suppliers, trade terms (RCD, MEN link, Sigenergy). "jay seven thousand six" becomes J7006.
- Sender sees cleaned text, edits or taps Send. Original audio attached, tap to play.
- Tagger picks up job numbers like any message.
- No signal: recording queues on the phone, sends when back in range.
- Custom vocabulary list editable in Settings.

### Hands-free "Hey Siri" (works through CarPlay)
- "Hey Siri, TEops message": Siri asks what to say, Shortcut posts the text to a Netlify function, Claude cleanup + job tagging, posted to chat, Siri says "Sent".
- No review step while driving; labelled "Voice message, cleaned by Claude".
- Optional: "read my TEops messages" reads unread aloud.
- **Auth:** personal, revocable token per staff member, tied to their login; admin revokes in Settings, Users.
- **Setup:** "Set up Siri" button installs the Shortcut via an iCloud link with the user's token.

**Dependencies:** team chat channels (feeds exist, see AI_AGENTS_PLAN.md); tagger agent; no AI consent needed in chat (Sparky is a member of every chat, decided 18 Oct 2026); Siri still needs per-user tokens.

**Open questions**
- [ ] Stay on AssemblyAI or switch (accuracy on Aussie accents and trade terms, cost)?
- [ ] Siri: default to General, or always ask which channel?
- [ ] Keep audio forever, or delete after X days?

---

## 3. Native iPhone app (Capacitor wrap)

**Today:** stage 1 built 18 Oct 2026 as **TEgo** (`tego-app/`, bundle ID `au.com.thomsonenergy.app`): loads the live site, native Apple push, black icon, cloud builds on GitHub. Waiting on Apple to approve the Developer account before it can be signed and installed. Setup steps, how it works and known gaps: `docs/IOS_APP.md`. Browsers keep the PWA and web push.

**Stage 1 decisions:** load the live site rather than bundling pages (one codebase, instant updates; bundle when offline mode is built); iPhone only, portrait; GitHub Actions on macOS for builds (free on this public repo), no Mac needed. Name TEgo can change any time; the bundle ID cannot.

**Decision:** wrap the existing web app with Capacitor, no rewrite. iOS only (whole team on iPhone). Keep the web app Capacitor-ready.

### What native unlocks
- **Offline (main reason):** on-device SQLite iOS won't clear, proper photo file storage, background upload/sync after the app closes.
- **Push:** more reliable than web push; needed for team chat replacing WhatsApp.
- **CallKit + PushKit:** TEops calls ring like normal phone calls, even when locked (item 7).
- Home screen widgets, Siri App Intents.
- Custom voice keyboard (iOS keyboards cannot use the mic, needs the "hop to the app" workaround). Lowest priority.

**Offline is still a design job:** save locally then sync: local queue, temp IDs, timestamps at the moment of action, conflict handling, chunked/retry photo uploads.

### Costs
- Apple Developer Program ~AU$150/yr, pay every year (lapsing pulls the app and risks push).
- Cloud macOS builds (GitHub Actions / Codemagic): ~$0 to $30/month.
- Private App Store listing (team only). Avoid long-term TestFlight (90-day expiry). Apple still reviews.
- Mac optional; buy (~AU$1,299 new) only if debugging gets painful.

### Sequencing
1. Web solid first: team chat, agents, offline queue pattern.
2. Capacitor wrap + native push + offline storage.
3. CallKit/PushKit for calls, widgets, Siri App Intents.
4. Voice keyboard.

**Dependencies:** Apple Developer organisation account (D-U-N-S 17 Oct 2026, enrolment submitted, Apple verifying); offline design decisions.

**Open questions**
- [x] Organisation account (D-U-N-S 17 Oct 2026)
- [x] Cloud build service: GitHub Actions (macOS runner)
- [x] Buy a Mac now or later: later, only if debugging gets painful
- [ ] Final app name (TEgo for now, can change any time)
- [ ] Offline conflicts: last write wins, or flag for review?

---

## 4. Weather-aware scheduling worker

**Goal:** flag rain, wind and heat risk on each booked job's site and stop outdoor work being booked on bad days. Small worker reporting to the ops manager, feeding the scheduling agent.

### How it works
- Per-site forecast from job lat/long.
- Work type on each job (or stage): Outdoor / Roof / Indoor. Roof and solar also check wind and extreme heat (safety).
- Checks each morning and midday (editable).
- **Notify on change only:** e.g. "Thu J7006 roof install now 80% chance of 15mm, suggest swapping with indoor J7010." Uses existing Web Push.
- **Booking guard:** scheduling agent avoids outdoor/roof work on high-risk days. Suggestions only, a human confirms.
- Rain/wind/heat icon per day on `schedule.html`.

### Horizon
- 1 to 3 days: act on it. 4 to 7 days: early warning. 7+: never acted on automatically.

### Admin settings
Rain probability % and mm, wind limit for roof (km/h), heat limit for roof (°C), check frequency, who gets notified.

### Data source
Open-Meteo (includes BOM model data; check commercial terms) or Willy Weather API (paid, AU-focused). A few dollars a month.

**Dependencies**
- **Job lat/long is not stored today** (only `leads` has lat/lng). Build: save coordinates from address autocomplete on jobs, backfill existing jobs by geocoding. Shared with item 6 geofence.
- Work type field on jobs/stages (new).
- Weather alerts can ship before the scheduling agent.

**Open questions**
- [ ] Open-Meteo vs Willy Weather
- [ ] Default thresholds (what does the crew actually work in?)
- [ ] Work type per job or per stage?
- [ ] Notify the crew directly, or just Jasper and the site supervisor?

---

## 5. Per-user inboxes with job tagging

**Goal:** most job emails sit in personal work inboxes (Cooper to a customer, Guy to a builder). Bring each user's work email into TEops so job emails are tagged, read and drafted by AI, and visible on the job.

**Built today:** shared sales@ inbox is LIVE: `google-oauth-start` / `google-oauth-callback`, `sync-gmail` every 5 min, Inbox / Sent / All tabs, `send-gmail`, `extract-email-job`. Not built: per-user Gmail OAuth, Mine tab, AI tagging and drafting.

**Decision:** per-user, opt-in. Supersedes admin-granted access to all mailboxes (see AI_AGENTS_PLAN.md). Admin access only revisited if people don't connect, and only after the staff notice.

### Layout
- One inbox screen, tabs: **Sales** (shared) and **Mine** (logged-in user). Later an SMS tab (item 7).
- Same tagging, AI reading and drafting code for both.

### Access
- Each user connects their own Gmail with one-tap Google sign-in. Opt-in, disconnect any time.
- Only users with an AI start date (item 6) get AI processing.

### Job tagging
- AI auto-tags when sure (job number, customer, site address), suggests when guessing, anyone tags manually.
- "Tagged by Claude" with one-tap undo, same as chat.
- **Tagged threads appear on the job for everyone.** **Untagged emails stay private** to the user, never shown or summarised.

### AI drafting
- Drafts from the thread plus job context (quote, schedule, POs, chat). Draft also created in Gmail.
- Drafts only; nothing sends without the user's click.

### Under the hood
- Gmail watch (push) for per-user mailboxes instead of polling.
- Store tagged emails and summaries only, not full mailbox copies.
- Feeds the ops manager digest ("3 customer emails unanswered 2+ days") and the chat assistant ("did the customer reply to Cooper?").

**Dependencies:** per-user Gmail scopes on the internal OAuth app; refactor `inbox.html` into a shared component; tagger agent; staff notice before AI reading.

### Inbox layout (built 18 Oct 2026, see spec A18)
- Page renamed **Sales inbox**. Toggle at the top: **Sales inbox** (sales@, shared) | **My inbox** (logged-in user's Gmail). jasper@ connected first.
- My inbox: connect from Inbox > My inbox with Google sign-in (same internal OAuth app, own refresh token per user, service-role only table), open to all staff. Workplace Surveillance Act notice first: agree (waives the 14 days) connects now, don't agree locks Connect for 14 days. Private to that user; only threads tagged to a job show on the job.
- Clean up for big old inboxes (owner has 23,613 unread): whole-inbox scan by sender, agent suggests archive / look / keep, one tap per sender. Full load of every old email was not done (slow and costly); 60 days are loaded in full.
- Sections, sorted by the triage agent (Gmail category labels and unsubscribe headers first, AI for the rest): **Priority** (agent flagged "you need to reply", with a one-line reason), **Other**, **Subscriptions and updates** (newsletters, receipts, notifications, marketing; skim when free to check nothing was missed), **Sent**, **All**. One tap moves a thread to another section; "always do this for this sender" saves a sender rule.
- Labels like Gmail: job threads keep job tagging (`email_job_links`); non-job matters get labels (for example "Supplier dispute: X", "Electrical licence application"). Labels sidebar with counts, open/done per label. Agent applies existing labels when sure, suggests new ones for a person to confirm. Sales inbox labels are team labels, My inbox labels are private. Built 20 Oct 2026: label sweeps over the last 60 days, agent-made labels (per-inbox switch), who-has-it (replied by, I've got this, assign) and the Tagged to jobs view (spec A18).
- Drafts: agent drafts replies for Priority threads. Draft shows inline at the bottom of its thread (edit, Send, Discard) and in a **Drafts** list in the top corner with a count. Nothing sends without a click.
- Migration planned: mailboxes table, `mailbox_id` on threads (sales@ backfilled), triage section and reason, labels and thread labels, drafts, sender rules. RLS changes so My inbox threads are private.

**Open questions**
- [ ] Replies to tagged threads auto-tag to the same job? (probably yes)
- [x] User disconnects: tagged emails stay on the job, private ones are removed from TEops (built).
- [ ] Director inbox: connect but exclude from auto-tagging?

---

## 6. Policy sign-off, AI consent and location tracking

**Law:** NSW Workplace Surveillance Act 2005: written notice at least 14 days before computer or tracking surveillance (employees can agree to less), a computer surveillance policy (s12), tracking only while at work. NSW Surveillance Devices Act 2007: consent for tracking devices.

**Built today:** onboarding makes staff sign the employment contract and `onboarding_documents` policies, with signed PDFs (migration 098, `generate-signed-document`). Versioned re-sign on login, I agree / I don't agree consent forms, consent dates per user and My Profile withdraw (migration 20261018120000, see PROJECT_SPEC A26). Not built: agents honouring the consent (no agents yet; AI start = later of consent date and the notice start date), location capture at clock in/out.

**Source documents (drafts, 18 Oct 2026):** `policies and Contracts/` has the "Notice of Workplace Surveillance and Computer Surveillance Policy" (required, acknowledge only, also gives notice of future location tracking), "AI Features Consent" (optional) and "Location Tracking Consent" (optional, load only when the iPhone app ships). Adviser (Formby or HR) review before go-live.

**Location decision:** the iPhone "Allow location" prompt is Apple's permission, not the written notice the Act needs, so location stays in the notice now (the 14 days is done before the app ships). The location consent form waits for the app.

### Sign-off flow
- Extend the onboarding signing: on login, anyone who has not signed the current version sees it full-screen and must sign first.
- Two separate tick boxes: (1) **AI features consent** (team chat, voice, email if connected); (2) **location tracking consent**.
- Signature + date. Signed PDF stored against the user and emailed to them.

### Records
- User, policy version, timestamp, both answers, signature.
- Settings, Users: who signed which version, choices, AI start date (or "not opted in").

### Per-user AI activation
- **Day one or not at all:** AI start date = sign date if box 1 ticked, else none. Later opt-in from settings sets it to the opt-in date (same consent screen).
- No AI start date: email cannot be connected. Team chat (including voice messages) is not covered by consent: Sparky is a member of every chat (owner's lawyer, 18 Oct 2026).
- Email is always opt-in even after the start date.

### Location tracking (box 2 only)
- **Clock in/out:** location captured once at the moment of clocking, checked against the job site geofence. Not captured today.
- **On my way:** shared only during a user-started trip until arrival; powers customer ETAs.
- **Never when clocked off.** Visible indicator whenever location is recorded.
- No consent: manual clock in/out with a note. Withdraw any time, effective immediately.
- Kept with timesheet records.

### Versioning
- Policy has a version number. A surveillance change means everyone re-signs; same day-one-or-not rule.

**Dependencies:** adviser-checked policy + 14 days' notice (high lead time); job lat/long (shared with item 4); timesheets clock in/out (exists); chat, inboxes, voice and SMS all respect the AI start date.

**Open questions**
- [ ] Typed or drawn signature? (match onboarding)
- [ ] Can location consent be required for clock-in verification? (adviser)
- [ ] Geofence radius
- [ ] Customer ETA by SMS (item 7) or a link?

---

## 7. SMS and calls via Twilio

**Goal:** text and call customers from TEops and receive calls and texts in the app, instead of personal phones or the ServiceM8 setup.

**Today:** not built. 0455 415 464 is on Telstra; ServiceM8 only uses it as a Twilio verified caller ID.

**Decision (17 Oct 2026):** no interim phase. The forward-to-mobile and click-to-call bridge is dropped; SMS and calls are built in one go after the native app (item 3), with TEops itself as the phone. Keep using the current setup until then.

**Plan**
1. Own Twilio account and AU regulatory bundle: done 18 Oct 2026 (`docs/EXTERNAL_ACCOUNTS.md`).
2. After the native app ships: build and test on the test number 0468 085 277.
3. Port 0455 415 464 from Telstra to Twilio once tested.

### Outbound
- **SMS button** on clients, jobs, quotes, invoices (J/Q/SI numbers), optional templates ("On my way", quote follow-up).
- **Call button** in the same places. Customer always sees the business number.
- Every text and call logged in the Activity Log (migration 042) against client and job.

### Inbound
- **Texts:** SMS tab in the inbox (beside Sales / Mine), matched by phone number, auto-tagged by the tagger. Push to opted-in staff inside their hours.
- **Calls:** ring all opted-in staff inside their hours; first to answer wins. Caller ID shows customer and open J numbers if known.

### Incoming call screen (owner requirement, 17 Oct 2026)
Staff must see at a glance: (1) it is a work call, (2) which client is calling, (3) that client's jobs, so they have the info ready.
- **Ringing (iPhone lock screen, CallKit):** iOS only allows one line of caller text. Shows "Thomson Energy" as the calling app, plus the client name and their main open J number, e.g. "Jane Smith, J7006". Distinct TEops ringtone. Unknown number: "New caller" plus the number.
- **Ringing (desktop):** a TEops pop-up with the full card below, plus Answer and Decline.
- **Once answered (iPhone and desktop):** TEops opens a call screen with the client card: name, phone, address, and each job (J number, site address, stage, next booking, assigned crew, balance owing), plus open quotes (Q) and unpaid invoices (SI). One tap opens a job. Unknown caller: one tap to create a lead.
- **Matching:** the incoming number is normalised and matched to clients (and leads); the server looks it up before ringing so the details arrive with the push. Several clients sharing a number: show all.

### Ringtones (decided 17 Oct 2026)
- A branded Thomson Energy default plus 4 to 6 alternatives. Each user picks theirs in Settings (calls and texts section); the admin sets the company default.
- iPhone apps cannot use the iPhone's built-in ringtones, so every ringtone is a sound file bundled in the native app (CallKit). Adding one needs an app update.
- Each file under 30 seconds (longer falls back to the iOS default), loops while ringing, small file size. The silent switch and Focus modes still apply.
- Desktop plays the same files in the browser, so both match.
- Sources: branded default made in GarageBand or by a sound designer; alternatives from Pixabay (free for commercial use), Zapsplat or Freesound (CC0 only). Keep a note of each file's source and licence.
- **Nobody available:** voicemail, transcribed, logged, pushed. Optional auto-reply SMS.

### Opt-in and hours (Settings, per user)
- Separate switches: receive calls, receive texts. Both off by default.
- Hours per weekday, Sydney time. Never rung outside them. "Off for the rest of today" toggle on Home.
- Outbound unaffected.
- Admin view: who is opted in, hours, warning if a business-hours slot is uncovered.

### How calls reach the phone
- **In-app softphone** (Twilio Voice SDK): calls go straight out of and ring inside TEops, no personal mobiles. The iPhone app uses CallKit + PushKit so calls ring when locked or closed (item 3); desktop uses the same SDK in the browser.

### Under the hood
- Twilio Messaging + Voice webhooks to Netlify functions (signature-verified). Supabase tables: messages, calls, voicemails, per-user availability (fast RLS, indexed FKs).
- Credentials in Netlify/Supabase env vars only.
- New push notification types (new SMS, missed call) on the existing per-type prefs.
- AI tagging/summaries only for users with an AI start date.

**Dependencies:** native app (item 3); Twilio account + regulatory bundle + port (high lead time).

**Open questions**
- [ ] Record calls? Needs a "may be recorded" message and staff notice coverage.
- [ ] Voicemail and auto-reply wording
- [ ] Ring the assigned job's crew first, then everyone?
- [ ] One business number, or extra numbers?
- [ ] SMS replies: shared thread, or owned by whoever last texted?

## 8. invoice@ supplier bill intake agent

**Goal:** suppliers email bills to invoice@thomsonenergy.com.au. An agent reads each bill and attaches it to the right PO, so nobody uploads bills by hand.

**Built 18 Oct 2026:** see `docs/PROJECT_SPEC.md` A11a. Google side done by the owner 18 Oct: invoice@ (Google Group) delivers to sales@, Gmail filter skips the inbox and labels `Supplier Bills` ("Bills" is reserved by Gmail). Only supplier bills go to invoice@ ("Hola Supply" was voice typing for "only supply"). accounts@ not used: TEops reads sales@ only.

**Next:**
- Migration 20261019000000 applied to production 18 Oct 2026 (staging skipped at the owner's request).
- 2 weeks suggest-only on production. If the confident matches are right, turn on auto-save (`api_keys` `supplier_bill_auto_save` = `on`).
- Price lists emailed to sales@ or invoice@ built 18 Oct 2026 (spec A11b): auto-update under 20% on known parts, the rest waits.
- Bill checks against POs, supplier queries from invoice@ and statement reconciliation built 18 Oct 2026 (spec A11c).
- Supplier or contractor type, suppliers created from bills, ABN Lookup check on every bill: built 18 Oct 2026 (spec A11a).
- Later: contractor licence and insurance expiry (certificate reader as for staff), warn before approving a bill from a contractor whose insurance has lapsed. Offered 18 Oct 2026, not yet asked for.
- Later: credit notes emailed to invoice@ (matched against queried bills) (today they land in To check as "not a bill"), add to stock from an emailed bill, Xero bill push.

---

## 9. Staff policy set (gaps and fixes)

Reviewed 18 Oct 2026 against `policies and Contracts/`. Have: Code of Conduct, Company Property, Staff Training and Development (all dated 28.10.2024), Surveillance Notice, AI consent, Location consent (drafts), Short Form Employment Contract.

**Missing but the contract already binds staff to them (clause "The Employer's policies", Vehicle and Tools clauses):**
- Tool Policy (what hand tools staff supply, test and tag, lost or stolen tools, tools register in item 1).
- Vehicle Incident Policy (accident steps, photos, police, insurance, who pays excess, fines and nominations).
- Disciplinary procedure (Code of Conduct section 5 refers to it): warnings, show cause, support person, procedural fairness.

**Missing, high priority (safety and legal duties):**
- WHS policy plus SWMS for high-risk work: roofs and heights, live or near-live electrical (isolation, lockout, test before touch), asbestos in old switchboards, heat, manual handling, incident and near-miss reporting.
- Drug and alcohol policy (driving, roofs, electrical work), including whether testing is done.
- Bullying, harassment, sexual harassment and discrimination policy, with how to complain (employers have a positive duty to prevent sexual harassment, and psychosocial hazards are a WHS duty).

**Missing, should have:**
- Licences and accreditations: keep electrical licence, CEC accreditation, white card and driver's licence current, upload expiry dates to TEops, report any suspension straight away.
- Leave, sick days and timesheets: how to request leave, call (not text) before start if sick, evidence, clock in and out in TEops, overtime approval.
- After-hours contact (right to disconnect, applies to small business since 26 Aug 2025): chat and push outside hours, on-call.
- Phones, IT, social media and customer privacy: no posting customer homes or details, passwords and phone lock, lost phone steps.
- Expenses and fuel card: receipts into TEops, what can be bought, personal use.
- Customer site conduct (could go in the Code): arrival, shoe covers, clean up, no cash, pets and children, being alone with vulnerable customers.

**Fixes to existing documents (for the adviser):**
- 2024 policies say "Thomson Energy": change to Thomson Energy Australia Pty Ltd ACN 689 985 831, re-date, give version numbers.
- Pay deductions (property, apparel, training repayment, insurance excess): Fair Work Act s324 needs written authorisation for a specific amount; a blanket policy line may not be enough.
- Training repayment: limit to optional training above a set cost; not for training the role or law requires; per-course signed agreement.
- Contract compliance clause names the Commonwealth WHS Act; staff in NSW fall under the NSW WHS Act 2011 and NSW Regulation. Also name NSW electrical licensing.
- Property policy allows personal vehicle use with approval; contract says work use only. Pick one. Add whether vehicles go home overnight.
- 24 month restraint ("do business with" any client): check enforceability and the planned federal limits on restraints.
- Property policy covers contractors, but contractors are not employees: separate subcontractor terms if needed.

**Delivery:** each policy goes into Settings > Onboarding as a versioned document (PROJECT_SPEC A26), so staff sign on login.

## 10. Purchase order upgrades (built 19 Oct 2026)

Live: see `docs/PROJECT_SPEC.md` A10 (migration 20261025000000).

## 11. Variation documents and in-app client emails (built 19 Oct 2026)

Live: see `docs/PROJECT_SPEC.md` A3 Variations (migration 20261028000000).

## 12. Stock and prebuilds on fixed-price variations (built 19 Oct 2026)

Live: see `docs/PROJECT_SPEC.md` A3 Variations. Code only.

## 13. Approve by phone or email and Decline, for quotes and variations (built 19 Oct 2026)

Live: see `docs/PROJECT_SPEC.md` A3 Variations (migration 20261029000000).

## 14. Quotes and variations expire (auto decline) (built 19 Oct 2026)

Live: see `docs/PROJECT_SPEC.md` A3 Variations (migration 20261030000000).

---

## 15. Security sweep and hardening (planned 19 Oct 2026, last step)

**When:** at the end of the build sequence, once major additions stop (after Tier 4 in PROJECT_SPEC Part 0). One consolidated sweep, then fixes, so nothing new lands half-reviewed. Plan first, owner's yes, as usual.

**Goal:** make sure TEops cannot be broken into, and limit the damage if an admin leaves a computer logged in or a password leaks.

### Protect against a logged-in computer left open
- **Re-enter password on admin-only pages** (Settings admin tabs, API Keys, Users and Roles, pay rates, Xero, HR letters, delete actions): asks for the password again before showing them, valid for about 15 minutes, then asks again.
- **Idle lock:** after a set time with no activity (setting, e.g. 30 minutes on a laptop), the app locks and needs the password (or Face ID, see B4).
- Sensitive actions (pushing pay rates, changing roles, deleting records, changing bank details, moving money) always ask again.

### Protect against a leaked password
- **Two-factor login for Admin and Finance** (authenticator app). This reverses the earlier "2FA deliberately left out" decision for those roles only; field staff keep simple logins plus Face ID.
- Supabase **leaked password protection** on (blocks passwords known from breaches) and a minimum password strength.
- Email alert to the person on a login from a new device; "Log out everywhere" (built) linked from that email.
- Lock an account after repeated wrong passwords.

### Sweep of the app itself
- Every table: RLS on, policies checked role by role, nothing readable by `anon` that should not be. Supabase security and performance advisors run and cleared.
- Every Netlify function: checks who is calling (logged in, right role) before doing anything; public ones (quote accept, webhooks) verify signatures or tokens and are rate limited.
- Storage buckets: private where they should be, signed links expire.
- Secrets: nothing in the repo or browser code; rotate keys in `api_keys` (Xero, Google, Airwallex, Anthropic, AssemblyAI, Formbay, Twilio) and Netlify env vars.
- Security headers (Content-Security-Policy, frame blocking), dependency audit (`npm audit`), remove unused functions and pages (the ServiceM8 deletion candidates, `sales.html`).
- AI agents: confirm least privilege and that none can move money, change permissions or deploy.
- Admin action audit log reviewed (who changed roles, rates, keys).

### Accounts around the app
- 2FA on every outside account: GitHub, Netlify, Supabase, Google Workspace admin, Xero, Airwallex, Twilio, Apple, Formbay.
- GitHub: protect `main`, review who has access. Supabase and Netlify: review team members.
- Backup restore test (`docs/STAGING.md`, never run yet).

**Open questions**
- [ ] Re-enter password timeout: 15 minutes?
- [ ] Idle lock time on laptops vs phones
- [ ] Which roles need two-factor (Admin and Finance proposed)
- [ ] Outside penetration test after the sweep, or not


## 16. Build rule checks in `npm run check` (decided against, 19 Oct 2026)

Owner's call: no automatic checks. Instead a whole-site review pass (like `docs/BUG_REVIEW.md`) after each big chunk of features is added; the build rules in `CLAUDE.md` guide each build.

## 17. User-friendliness upgrades (whole-app review, 19 Oct 2026)

**Status:** owner said yes to building all 168 (19 Oct 2026). Deliveries 1 to 4 (items 1 to 109) LIVE 19 to 20 Oct 2026; next is delivery 5 (items 110 to 146 less the PO items moved to `docs/PO_REVIEW.md`). Waiting with the next migration: `email_label_counts(p_mailbox)` grouped label counts for the Inbox (UX 107, SQL in the delivery 4 PR). Full list with file and line references in `docs/UX_REVIEW.md` (168 items in 10 themes, 125 of them small effort, re-checked after main's 19 Oct fixes). Quote item numbers to pick, for example "UX 1, 2 and 6".

**Do first (top ten, best first):**
62. Inputs are 14px so iPhones zoom on every tap
93. Every page blocks on an unpinned CDN copy of supabase-js
2. My Day shows Clock in before it knows you are clocked in
31. Site address and client phone never shown on the job page
33. Word, Excel and knowledge files do not open on iPhone (window.open after await)
19. CCEW and Installed equipment cards are hidden on the day the job is finished
49. Save buttons stay live while saving, double taps make duplicates
35. Site photo upload: no count, a failure loses the batch
123. Invoices list has no unpaid filter or search
5. Field staff cannot report an incident from site

**Delivery plan (agreed 19 Oct 2026):** build all 168, in about six deliveries by theme so each lands and gets tested on its own: (1) the top ten plus the shared pieces later items reuse; (2) items 1 to 30 (clock in, My Day, schedule, tasks, finishing a job); (3) 31 to 82 (job page, feedback and saving, phone layout); (4) 83 to 109 (navigation, speed); (5) 110 to 146 (invoicing and Xero, office and public pages); (6) 147 to 168 (login, chat, inbox, settings, HR). Delivery 1 LIVE 19 Oct 2026 (migration 20261104000000_report_incident.sql for item 5). Next: delivery 2, plan then owner's yes.

**Follow-up from delivery 2 (LIVE 20 Oct 2026, migration 20261106000000):** `book_back_after_clockout(p_project_id, p_date)` security definer function so Staff-role tradies can be booked back on a job they clocked out of today; checks the caller clocked out of that job today (Sydney), skips if already booked that day, inserts 07:00 to 15:00. Client calls it instead of the direct insert.

**PO items handed over (20 Oct 2026):** UX items 101, 121, 125, 126, 128, 134, 135, 136, 137, 139, 140, 146 (POs, supplier bills, stock, price lists) are built with the PO fix plan in `docs/PO_REVIEW.md` by the laptop chat, not in UX deliveries 4 to 6.

**Menu layout (agreed with the owner 20 Oct 2026, first part of delivery 4, UX 83, 84, 87, 91):** Pipeline becomes a top bar icon like Schedule, Settings, Chat and the bell. The menu has four groups, each opening its pages; every page shows its icon. **Sales:** Leads, Quotes, Jobs (renamed from Projects), Invoices, Clients, Reviews, Inbox, STCs, Customer equipment (renamed from Assets). **Purchases:** Purchase Orders, Stock, Vehicles (renamed from Fleet), Suppliers, Tech Support (name unchanged: suppliers' and manufacturers' tech support numbers), Emailed bills, Bill checks, Price lists, Prebuilds, Tools (when built). **Team:** My Day, Schedule, Tasks, Timesheets, Chat, Meetings, Knowledge, Documents, Incidents, Team. **Office:** Overheads, Ops manager, Updates and ideas (renamed from Bugs & Updates), DNSP, Logs, Settings. Roles still hide what they cannot use; stars and Home tiles stay. LIVE 20 Oct 2026 (delivery 4).

**Themes (item numbers in docs/UX_REVIEW.md):**
- Clock in, My Day, schedule, timesheets and tasks: items 1 to 18
- Finishing a job on site: CCEW and installed equipment: items 19 to 30
- Job page: items 31 to 48
- Feedback and saving: items 49 to 61
- Phone layout, tap targets, forms and keyboards: items 62 to 82
- Navigation and findability: items 83 to 92
- Speed: items 93 to 109
- Invoicing, Xero and payroll: items 110 to 119
- Office and public pages: quotes, leads, clients, POs, stock, price lists, STCs, assets and licences: items 120 to 146
- Login, policy update, Chat, Inbox, Settings and HR: items 147 to 168

## 18. Knowledge Base background reader (built 19 Oct 2026, see PROJECT_SPEC.md A32)

**Built as planned below, 19 Oct 2026.** Migration 20261104010000 on production. Left to watch: how many AS/NZS 3000 pages still fail after the one-page and notes fallbacks, and whether the "table on the page" rule sends too many pages to the picture read.

**Problem found:** "Read with OCR" renders PDF pages in the browser, so the phone has to stay on the page with the screen on. On AS/NZS 3000 (610 pages) 438 pages were read and 43 batches (about 172 pages) failed, every one with the same Anthropic error: `Output blocked by content filtering policy` (the copyright output filter, triggered by asking for 4 pages of a standard word for word). Re-running the same way would fail on the same pages. Other standards are worse: AS 3012 has no text at all, AS 1768 has 2k characters, AS 3008 has 10k characters across 148 pages. Putting the PDFs in the GitHub repo does not help Sparky (he reads the database through Netlify, not GitHub) and purchased standards in GitHub is a licence problem.

**Proven 19 Oct 2026:** a Netlify function can render PDF pages itself (`pdfjs-dist` 3.11.174 legacy build plus `@napi-rs/canvas`, no native compile, about 0.3 s a page, handles the owner-password encryption purchased standards use). So the whole read can run on the server with nothing open on the phone.

**Plan:**
1. **Queue, not screen.** Tables `knowledge_read_jobs` (one per read: entry, mode, total pages, next page, done, failed list, status) and `knowledge_pages` (entry, page number, text, how it was read: text layer / ocr / notes, error). Uploading a PDF, or "Read again" on an entry, creates a job. `read-knowledge-background` works through pages for up to 12 minutes, saving each page as it goes, then calls itself for the next stretch; a 2-minute sweep restarts anything stalled. The Knowledge page shows "Read 212 of 610 pages, 3 failed", and a phone notification lands when the read finishes.
2. **Cheapest reliable read per page.** Text layer first (free, exact). A page whose text layer is thin (tables in fonts with no text mapping, the AS 3008 case), or any page when "read every page as pictures" is chosen, is rendered and read by Claude as an image, one page per API call (shorter answers get past the filter far more often than 4-page batches).
3. **Filter fallback.** A blocked page is retried once; blocked again, Claude is asked for structured reference notes instead (every clause number, requirement and table value as data, not word for word) and the page is marked "notes"; still blocked, the page is marked failed with the reason and a "Retry failed pages" button re-queues just those. Sparky says when an answer comes from a notes page.
4. **Sparky searches pages, not blobs.** Postgres full text search (`tsvector` column, GIN index) over `knowledge_pages`; `search_knowledge_base` returns "AS 3000, page 212: ..." snippets and `read_knowledge_entry` takes a page range. Replaces the per-word `ilike` over an 884k-character column. `knowledge_entries.content` stays stitched from the pages so nothing else changes.
5. **Catch-up.** AS 3000's existing text is split into pages by its `--- Page N ---` markers (no API cost) and only the 172 failed pages are re-read; AS 3008, AS 3012 and AS 1768 are queued in full. The old browser OCR panel and `knowledge_ocr_parts` go.

One migration (tables, indexes, RLS to authenticated for reads, server-only writes, search function with fixed search path). Cost: a few cents a page read as an image, well under $20 for all four standards.


## 19. Email drafts in the owner's own tone, answers not recaps (built 19 Oct 2026)

Why: Postie's drafts sound generic and parrot the sender's email back before answering. The owner's sent mail is already in TEops (`emails` rows with `direction = 'outbound'`, 60 days of backfill, about 200 for jasper@ and 50 for sales@), so the agent can learn the tone without any new Gmail access.

1. **Learn from sent mail.** A server function pulls a mailbox's outbound emails from TEops, strips signatures, quoted text and forwards, keeps the top 80 real replies, and asks Opus 5.5 for a short style guide (greeting, sign off, sentence length, how we say no, how prices and travel are quoted, usual phrases, never-dos) plus 6 to 8 real replies verbatim, each paired with the email it answered. Saved per mailbox: `mailboxes.writing_style`, `mailboxes.writing_style_learned_at` (one small migration).
2. **Settings > Email.** "Learn from my sent mail" button, the guide in an editable text box, Refresh. sales@ has its own guide (Admin edits). Re-learned every 30 days.
3. **Drafting prompt.** Never repeat or summarise what they wrote; first sentence is the answer; one line per question asked; nothing asked means say what happens next; three to six sentences unless more is truly needed. The style guide and paired examples go into the prompt. Square bracket gaps stay, one gap in the answer line, no hedge paragraph.
4. **Later (needs draft edit tracking):** learn from edits. Keep the AI draft and what was actually sent, feed the differences into the next refresh.

Built 19 Oct 2026, migration 20261103020000: items 1 to 3 as above (Settings > Email Agent, tab now visible to everyone, auto replies card still pricing roles only). Item 4 (learn from edits) stays an idea. Detail in `docs/PROJECT_SPEC.md` A18.

## 20. Company voice, spell check and Polish everywhere (built 19 Oct 2026)

Why: the owner wants every mailbox and every person to write in his voice by default, with the option of their own learned style later, and spelling fixed everywhere with a Polish option that restructures sentences in the company voice.

**A. Company voice**
1. Admin picks the company voice in Settings > Email Agent (dropdown of mailboxes with a learned style): `company_settings.writing_style_mailbox_id`.
2. Every mailbox has `writing_style_source` ('company' default, or 'own'). sales@ and every My inbox start on company voice; a person switches to their own after pressing Learn on their row.
3. Postie drafts with whichever is picked; greeting and sign off still belong to the mailbox in use.

**B. Spell check and Polish everywhere**
1. One shared script (in `supabase-client.js`, already on every page) attaches to every multi-line text box, including ones created later. Single-line fields (names, addresses, amounts) and serial number boxes are left alone.
2. Spelling fix, automatic by default: on leaving a text box, Claude Haiku 5.5 fixes spelling and obvious typos only (never wording or meaning, keeps line breaks, Australian spelling, trade words untouched). If anything changed: "Spelling fixed, Undo" under the box for a few seconds. Chat runs it just before sending.
3. Polish button on any text box with 5+ words: Claude Sonnet 5.5 restructures the sentences in the company voice (answer first, shorter sentences, clear order), keeps every fact, never adds. "Polished, Undo".
4. Per person setting (Settings > Email Agent, everyone): `profiles.spellcheck_mode` = auto (default) / button / off.
5. Server: new `polish-text` function (login check). `cleanup-text.js` gets a login check too (it has none today).

Built 19 Oct 2026, migration 20261103030000. jasper@ set as the company voice in the migration. The script lives in `js/writing-help.js` (loaded by `supabase-client.js`). Detail in `docs/PROJECT_SPEC.md` A18 and A33. Later idea: a shared company word list (trade words, client names) instead of the per-device Undo list.

## 21. Schedule tab, client booking emails, client picks a time (built 19 Oct 2026)

Why: the owner books jobs tentatively about 3 weeks out (staff see it in My Day, no staff email), then confirms with the client about 3 days before once the job is sure to go ahead; moves and cancels need the same; and the client should be able to pick from time options we offer.

1. **Schedule tab** on every job: bookings by day (who, time, "Client informed <date>" green / "Client not informed" amber), Move and Cancel per day; buttons Book people (current Book form), Email client booking, Ask client to pick a time; time options sent (what, picked or not, Copy link, Withdraw); every schedule email sent (date, sender, link to the email).
2. **No staff emails** (owner, 19 Oct 2026): staff see their bookings in My Day as now. My Day and Schedule mark a booking "Tentative" until the client is informed.
3. **Email client booking**: editable email (job name and number, when, where, who) to the job contact, else the job client email, from sales@ under the sender's name, tagged to the job. Marks "Client informed".
4. **7am reminder** (phone notification) to whoever made a booking that starts within 3 days with the client still not informed. Bookings record who made them from now on.
5. **Move**: new date or time, tick box "Email the client the new time" (ticked if the client was informed before). **Cancel**: tick boxes "Email the client" and "Offer new times" (opens the time options form with the same people and times).
6. Book form gets an "Email the client" tick box too.
7. **Ask client to pick a time**: people, time of day, number of days, 2 to 6 date options; options clashing with a chosen person's bookings are greyed out ("Guy is booked 7:00 to 3:30"). The client gets a private link to a simple page (job number and name, address, options as buttons, "None of these work" with a message to the office). Picking one: server re-checks the people are free and books them all or nothing (already "Client informed"), confirmation email to the client, phone notification to the person who sent it, other options close; a slot taken meanwhile is greyed out and they pick again.
8. Schedule page: bookings with the client not informed get a dashed outline and "Tentative".
9. One migration: `schedule_assignments` gets client informed and made by; new tables for time options sent to clients and the schedule email log (fast RLS, FK indexes). The client page is the only new public page, through one server function with the private link as its check.

Later: nothing yet.

Built 19 Oct 2026, migration 20261104020000. Detail in `docs/PROJECT_SPEC.md` A34. Later ideas: SMS the booking instead of email for clients with no email address; a company word list for the spell check.

## 22. PO, supplier bills, stock from My Day and the tools register (reviewed 20 Oct 2026)

Full review, bug list, gaps and the four-delivery plan are in `docs/PO_REVIEW.md`. In short: delivery 1 fixes the PO, bill and stock rules (bill save never touches stock, Close is the approval, pay-on date, mark paid and a pay batch, one server function for every stock count change); delivery 2 shows bills and their lines in red on the PO with Add to PO and Query supplier, and lets an open PO fill from the invoice; delivery 3 adds Used stock on My Day and the clock-out prompt, adding a missing part with "Needs a price", and the adjustment history on Stock; delivery 4 is the tools and equipment register (Tools PO, any PO line marked as a tool, serial / photo / receipt over $500). Tools register detail from item 1 moves there when built. Owner's answers to the 10 questions are in `docs/PO_REVIEW.md`. Parked for later: returns to supplier and credit notes; usage-based consumable depletion (AI suggests pack use from job materials and prebuild ratios, a person confirms) once a few months of job data exist.

## 23. Investment breakdown page on proposals (built 21 Oct 2026, migration 20261114000000)

Owner's ask: a toggle on the quote, default off, that adds an "Investment breakdown" page straight after the Investment summary listing each stage's line items; a prebuild shows as its client description, never its parts.

Plan:
1. New column `projects.show_investment_breakdown` (default off), added to the fields `get_quote_by_token` returns (one migration).
2. Tick box "Show investment breakdown" on the job's quote edit form next to Deposit.
3. Proposal page: when ticked, an A4 page "Investment breakdown" after the Investment summary: per stage its name, then its lines (description and quantity), then the stage price ex GST. Long lists carry on over extra sheets with the stage heading repeated (same pagination as the summary).
4. No line prices on the page: 4 of 12 priced stages have a hand-set stage price that differs from the sum of their lines, so line prices would not add up for the client. The click-to-open stage lines on the web summary already show line prices; the plan leaves that as is unless the owner says otherwise.
5. Variation approval pages and quick estimates: no breakdown.

Built as planned (points 1 to 5), detail in `docs/PROJECT_SPEC.md` A22.

Also found and fixed in the same delivery: Jasper's own My inbox has never finished a Gmail history page (last synced never), the same one-by-one fault fixed for sales@ on 20 Oct. Fix: the personal sync uses the sales@ page logic (known mail ruled out in one query, drafts skipped, 4 at a time).

## 24. Gather first, generate last: pre-quote information, Battery proposals, send gate (built 21 Oct 2026, migration 20261115000000)

Live: see `docs/PROJECT_SPEC.md` A3 "Gather first, generate last". Built as planned (points 1 to 11) with two corrections from the research: the federal discount covers batteries of 5 to 100 kWh usable (paid on the first 50 kWh, tiered from 1 May 2026), and SAA runs battery work as its own class (grid connected battery systems, GCBS) rather than an endorsement; the gate looks for a Team licence named with "SAA" and "battery". The "what the customer gets" panel is built in the browser from the answers, Pylon and the stages (no new column). The plan as agreed follows.

Owner's ask (21 Oct 2026): a quote should start by gathering information (on the phone or at a site visit), which can be changed at any time, with questions that fit the proposal type (a Solar proposal asks solar questions), then generate what the customer gets and the scope of works from that at the end, not be pushed into writing the scope straight away. Batteries become their own proposal, a Solar proposal can tick Batteries as well, battery quotes follow the SAA and Clean Energy Regulator battery rules, and nothing is sent until every pre-quote item is checked.

**Today:** `new-project.html` is one long form: type, questions (renovation and service work only), client, Pylon, AI scope brief (not saved, one use), scope text, photos, stages (a named stage is required to save), payment, T&Cs, compliance (solar only, after saving). Solar has no questions, batteries exist only as Pylon pull data, and sending a quote checks nothing.

**Plan:**
1. **Battery proposal.** `battery` added to `projects_proposal_template_check` (migration), a Battery button on the new quote and quote edit pages, battery cover photo and a "Your system" page on the proposal (battery make, model, usable kWh, backup circuits, VPP, rebate line). Solar proposal gets a tick "Batteries as well" (saved in `template_answers.with_battery`); ticked, it takes the battery questions and rules too. Battery STC credit uses the existing per-stage STC fields (count typed in, $ per STC as now), no new money logic.
2. **Pre-quote information card** at the top of every quote (new and edit), editable any time, saved on `projects.template_answers` (already jsonb): where it came from (phone, site visit, client email) and when; questions per type. Solar: grid, off-grid or VPP interest; existing solar or battery to tie into; life-support equipment on site; roof type and condition; storeys; switchboard and main switch; single or 3 phase; NMI and DNSP; export limit; daily use or bill attached; shading; access. Battery (Battery proposal, or Solar with Batteries as well): usable kWh wanted and what must stay on in a blackout; existing PV size and inverter; hybrid or AC coupled; where it goes (not a habitable room, clearances per AS/NZS 5139, indoor or outdoor, distance to the switchboard); VPP capable; on the CEC approved list; usable size 5 to 50 kWh; first battery at this address (one claim per premises); solar commissioned before the battery; state rebate as well; internet for monitoring. Each question says whether it is needed before sending. New build, renovation and service work keep their questions, moved into the same card. Completed site inspection answers show on the card with a link.
3. **Save at any point.** A draft saves with name and client only; stages are optional until the quote is sent (PDF not made while there are no priced stages). The AI brief is saved (`projects.sow_brief`, same migration) so it can be edited later.
4. **Generate last.** The page runs in order: type, client and site, pre-quote information, design and pricing (Pylon and stages), then "What the customer gets" (system summary from the answers, Pylon equipment and stages) and the scope of works generated from the brief, answers, equipment and stages (`generate-scope.js`, `generate-sow.js` take `templateAnswers`, `equipment` and `template`; battery wording covers backup circuits, location, VPP, rebate and AS/NZS 5139). Regenerate or edit any time; the installer summary follows as now.
5. **Ready to send gate.** `check-solar-compliance.js` becomes a per-type readiness check: required pre-quote answers, at least one priced stage, deposit, terms; the existing solar rules; new battery rules (model and usable kWh set, on the CEC list, VPP capable, 5 to 50 kWh, first battery at the premises, location answered, a staff member with SAA accreditation plus the battery endorsement on file). "Email quote to client" and moving to Quote Sent show the gaps and stop; Admin and Finance may send anyway with a reason that is logged on the quote.
6. **Job tasks on approval.** Battery jobs (and Solar with Batteries) get pre-job and handover tasks from the answers: CEC list check at install time, DNSP battery application, VPP registration, AS/NZS 5139 location sign-off with a photo, battery serials, Formbay battery job (`template-job-tasks.js`, `create-default-job-tasks.js`).
7. **Rules on paper.** `docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md` written from the CER Cheaper Home Batteries Program pages, the CER battery inspection checklist and SAA, like the solar one; the rule file in code cites it. Open points to confirm with the owner: the program changes from 1 May 2026 (CER has announced them, detail not yet read) and the exact SAA battery endorsement wording.

8. **Ex GST everywhere, GST at the end.** Line item unit costs, labour and materials totals and stage sale prices are already ex GST, and the proposal adds GST (10%) once under the totals. Every stage card and the line item headings say so in plain words ("All amounts ex GST. GST is added once at the end of the quote.") so a salesperson never keys an inc GST price. Same wording on the quote edit page and variation lines.
9. **STCs only on Solar and Battery.** The STC credit block on each stage, and the default $ per STC and zone fields, show only when the proposal is Solar, Battery, or Solar with Batteries as well; other types never show them (a stage that already has an STC total on an older quote keeps showing it so nothing is hidden).
10. **STC count or system size, either one.** New field "Number of STCs" on the stage next to the system size: type the count and the total is count x $ per STC; type the size and the count fills from the calculator (zone, year, deeming) as now; the typed count wins when both are set. Saved as `cost_centres.stc_quantity` (same migration), and the job's STCs tab offers that count on its first row instead of working it back from the kW. Needed for batteries, where the count comes from usable kWh, not kW.
11. **New prebuild from inside a quote.** The Prebuilds page works (owner confirmed 21 Oct 2026). The ask: while pricing a stage and finding the library has no prebuild for it, make one without leaving the quote. The stage's "+ Search material / prebuild" picker gets a "+ New prebuild" choice that opens the same form as the Prebuilds page in a popup (name, part number, category, subcategory, client description with Generate with AI, components with the Stock type-ahead). Save does two things in one step: saves it to the prebuild library (`prebuilds` and `prebuild_components`, pricing roles as now) and adds it to that stage like any picked prebuild (labour line at the stage's rates, materials marked up, the client description on the stage). The form moves out of `prebuilds.html` into a shared module (`public/js/prebuild-form.js`) so both pages use the one form.

Migration: one small file (`battery` template value, `projects.sow_brief`, `cost_centres.stc_quantity`), run on production after the yes. No staging (paused).

## 25. AI guesses the parts: prebuild components from the description, prebuilds on cost centres from the scope (built 21 Oct 2026, migration 20261116000000)

Live: see `docs/PROJECT_SPEC.md` A3 "AI guesses the parts". Built as planned (points 1 to 3). The plan as agreed follows.

Owner's ask (21 Oct 2026): on the Prebuilds page, the AI should guess the materials (components) a prebuild needs from its name and description, not only write the description from the components. On a quote, the AI should read the scope of works (and the pre-quote answers) and suggest prebuilds from the library to add to each cost centre, with the AI-added ones highlighted so a person checks them before the quote goes out.

**Order:** build after item 24 is on `main`, as its own delivery. Both touch the same files (`new-project.html`, `project.html`, `prebuilds.html`, the prebuild and scope functions), so two chats working at once would collide; one chat does 24, then any chat picks this up from this note.

**Plan:**
1. **Prebuild components from the description** (`prebuilds.html`, new `suggest-prebuild-components.js`, pricing roles only). Button "Suggest components with AI" next to Generate: sends the name, client description, category and the Stock list (name, category, cost) to the model, which returns components (type labour or material, description, quantity, Stock match when one fits). Rows land in the form marked "AI suggested, check" (amber left border and tag) until edited or ticked Confirm; a Stock match fills the unit cost from Stock, an unmatched part is typed with cost blank and flagged Needs a price. Nothing saves until Save prebuild. Also fix `generate-prebuild-description.js`, which has no caller check today: add `requirePricingRole` (it spends the Anthropic key).
2. **Prebuilds on cost centres from the scope** (`new-project.html`, `project.html` quote edit, new `suggest-stage-prebuilds.js`, pricing roles only). After the scope of works is generated or pasted, a button "Suggest prebuilds for each stage": sends the stage names and descriptions, the scope, the pre-quote answers and the prebuild library (name, category, subcategory, client description, component count) and gets back, per stage, prebuilds to add with a quantity and one line of reasoning. Each lands on the stage through the same path as the picker (labour line at the stage's rates, materials line marked up) and carries `ai_suggested: true` on the line item (jsonb or a boolean column, decided with the item 24 migration if built together) so the stage shows it with an amber tag "AI added, check" and a Confirm tick; the sale price updates as usual. Confirm clears the tag; Remove drops the lines. The ready-to-send gate (item 24 point 5) lists any unconfirmed AI line as a gap.
3. **Never silent:** the AI only suggests from the library and Stock, never invents prices; a quote cannot be sent with an unconfirmed AI line; the Logs page records each suggestion run (who, quote, how many lines).

Migration: `cost_centre_line_items.ai_suggested boolean default false` (or folded into item 24's migration if the owner says yes to both at once).

## 26. STCs and BSTCs separate (planned 21 Oct 2026, waiting on owner's yes)

Owner's ask (21 Oct 2026): make BSTCs (battery certificates) and STCs (solar PV certificates) separate on a quote, not one combined "STC credit".

**Today:** one STC credit block per stage (count, system size, zone, year, $ per STC, total) and one "STC credit" line on the proposal, one `stc_amount` per invoice claim and one "STC Credit" Xero line on the `stc_credits_individual` / `stc_credits_company` mapping. The job's STCs tab already keeps PV, battery and hot water rows apart (`job_stcs.stc_type`), and Formbay pays them apart.

**Option A (recommended): separate on the quote and the proposal, one credit on the invoice.**
1. Migration: `cost_centres.bstc_quantity`, `cost_centres.bstc_price_per_certificate`, `cost_centres.bstc_total` (default 0); `get_quote_by_token` returns `bstc_total` per stage.
2. Stage card: the existing block becomes "STC credit (solar)" with the count or system size as now; a second block "BSTC credit (battery)" with number of BSTCs and $ per BSTC (count typed in from Pylon or Formbay, TEops does not work the tiered battery factor out), total = count x price. Shown on Solar and Battery proposals only, the BSTC block only when the quote has a battery.
3. Proposal Investment summary: two lines, "STC credit" and "BSTC credit" (company clients inc GST on both, as now), total after both. Investment breakdown unchanged.
4. Invoices and Xero unchanged: the stage's claimable credit is STC total plus BSTC total, still one `stc_amount` per claim and one "STC Credit" Xero line (Xero books both to the same STC income account today, `docs/BUSINESS_FACTS.md`: $35 per certificate either way).
5. Job STCs tab: the first PV row is offered from the STC count and a battery row from the BSTC count.
6. Ready-to-send: a battery quote with batteries must have a BSTC count and total (or zero on purpose, ticked).

**Option B: separate all the way through invoices and Xero.** Everything in A plus `bstc_amount` on `invoice_claims`, `invoices` and credit note claims, "BSTC Credit" line in Xero on new `bstc_credits_individual` / `bstc_credits_company` mappings (Settings > Xero Mapping), both lines on the invoice PDF and the invoices list, `get_invoice_balance_due` and the paid-amount maths updated, credit note reversal per kind. Only worth it if Xero needs BSTC income on its own account.

Best model: Fable 5.1, effort xhigh (money and a migration that re-declares `get_quote_by_token`).

## 27. Quote in steps: create first, then pre-quote info, site visit, pricing, scope of works, send; STC and BSTC credits at quote level (planned 21 Oct 2026, waiting on owner's yes)

Owner's ask (21 Oct 2026, after item 24 went live): creating a quote should be just the client details and the proposal type, then Create. Everything else is added to the saved quote afterwards, in order: pre-quote information, a site visit if needed, the quote (pricing), then the scope of works, then send. STCs and BSTCs are entered on the quote, not inside a cost centre; which stage they are claimed against can be chosen later. Supersedes item 26 (which put BSTCs on the stage).

**Plan:**
1. **Create quote (`new-project.html` shrinks).** Proposal type buttons, project name, client (search or new), site address, payment terms, notes. "Create quote" draws the Q number, saves the draft and opens the quote at step 1. Lead, email and assistant prefills still land here. The long form is retired; everything below moves to the quote's own page.
2. **Quote steps on the quote's page (`project.html`, quotes without a job number).** A step bar under the heading: 1 Pre-quote info, 2 Site visit, 3 Pricing, 4 Scope of works, 5 Send. Each step is a card with its own Save, so a phone can do one step at a time; a tick shows when a step is done, and any step can be reopened. The whole-form "Edit / Save changes" mode goes for quotes (jobs keep the cost centre editor as now).
   - 1 Pre-quote info: the question card from item 24 (source, date, who, the type's questions, Batteries as well), lead attachments offered, Save answers.
   - 2 Site visit: "Needs a site visit" with Book (picks the inspection checklist template, makes the `site_inspections` row, link to fill it on site), or "No site visit needed" with a one-line reason; status and the completed answers shown here.
   - 3 Pricing: Pylon (solar and battery), stages and line items (the existing cost centre editor), deposit and milestones, investment breakdown tick, and the new quote-level credits (point 3).
   - 4 Scope of works: What the customer gets, brief and documents, style, Generate, the scope text with Cleanup, reference photos, proposal subtitle, terms.
   - 5 Send: Ready to send check (item 24 gate), Make PDF and preview, Email quote to client, valid until.
3. **STC and BSTC credits on the quote, not the stage.** New columns on `projects`: `stc_quantity`, `stc_system_kw`, `stc_zone_rating`, `stc_install_year`, `stc_price_per_certificate`, `stc_total`, `bstc_quantity`, `bstc_price_per_certificate`, `bstc_total`, and `stc_cost_centre_id` / `bstc_cost_centre_id` (optional: the stage each credit is claimed with; blank means the last stage). Two blocks on step 3: "STC credit (solar)" (count, or system size with zone and year to fill the count, $ per STC, total) and "BSTC credit (battery)" (count and $ per BSTC, total); shown on Solar and Battery proposals, the BSTC block only when the quote has a battery. The migration copies each existing quote's stage STC totals up to the quote (sum; count and price from the first stage that has them) so nothing changes on live quotes; the stage columns stay for history and stop being shown.
4. **Proposal:** two lines on the Investment summary, STC credit and BSTC credit (inc GST for a company client as now), total after both; `get_quote_by_token` returns the quote-level figures (function re-declared in the migration).
5. **Invoices and Xero (owner, 21 Oct 2026): two lines, same account, kept apart on the job.** STC and BSTC are approved and paid separately by Formbay, so they stay separate all the way: `bstc_amount` on `invoice_claims`, `invoices` and credit note claims (migration); each credit is offered on the claim for its linked stage (or the last stage) once that stage is fully claimed, remaining = the quote's figure less what has been claimed of that kind; the invoice PDF, the invoices list and the job's Invoices tab show "STC credit" and "BSTC credit" as two lines; Xero gets two lines, "STC Credit" and "BSTC Credit", both on the existing `stc_credits_individual` / `stc_credits_company` mapping (same chart of accounts code, no new mapping); credit notes reverse each kind on its own; `get_invoice_balance_due` and the paid-amount maths include both. `create-job-from-quote.js` carries the quote-level figures onto the job.
6. **STCs tab:** the PV row offered from the quote's STC count, a battery row from the BSTC count.
7. **Ready to send:** the solar and battery STC rules read the quote-level figures.

Best model: Fable 5.1, effort xhigh (money on live quotes, a migration that moves data and re-declares `get_quote_by_token`, and the quote page rebuilt in steps).


## 28. Schedule month view: equal columns, fixed cell height with scroll, one chip per job (planned 21 Oct 2026, waiting on owner's yes)

Found from the owner's photo of the October 2026 month view: columns come out uneven (Sun, Fri and Sat squeezed narrow, Mon to Thu wide) because the grid uses `1fr` columns, and busy days grow the row because cells have a minimum height and no maximum.

Plan, one file (`public/schedule.html`), no migration:

1. Equal columns (`minmax(0, 1fr)` and `min-width: 0` on the cell) so every day is the same width.
2. Fixed cell height (about 120px desktop, 80px phone). The chip list inside scrolls when it overflows, with a faint fade at the bottom. The whole cell still clicks through to Day view.
3. A muted booking count next to the day number (for example "21 · 7").
4. One chip per job per day ("J7004 Florist power relocation · Guy, Casey") instead of one per person. Leave chips stay per person.

Confirmed the same day, how the schedule and timesheets relate (no change planned unless the owner asks): both views show bookings (`schedule_assignments`) only. A time entry never creates a booking. On past days, Day view locks a booking to its real clocked times when there is matching clocked time, and removes a booking nobody clocked on to. Clocked time with no booking (for example a timesheet added later because someone forgot to log in) shows nowhere on the schedule. Possible follow-up if wanted: show it on past days as a grey "worked, not booked" block.
