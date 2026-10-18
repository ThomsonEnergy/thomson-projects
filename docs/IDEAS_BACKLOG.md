# TEops Ideas Backlog

Last updated 18 Oct 2026

Planned work not yet in docs/PROJECT_SPEC.md Part A. Code is the source of truth: if something here is built, move it to the spec.

## Status

| # | Item | Status | High lead time | Depends on |
|---|------|--------|----------------|------------|
| 1 | Payment reconciliation, receipts, tools register | Partly built | N | Airwallex read-only key, accountant sign-off |
| 2 | Voice messages in team chat + Siri Shortcut | Not started | N | Team chat channels, tagger agent, policy sign-off (6) |
| 3 | Native iPhone app (TEgo, Capacitor) | Stage 1 built, waiting on Apple | Y | Apple Developer enrolment approval, then `docs/IOS_APP.md` setup; offline sync design for stage 2 |
| 4 | Weather-aware scheduling worker | Not started | N | Job lat/long (not stored today), work type field |
| 5 | Per-user inboxes with job tagging | Partly built | N | Per-user Gmail OAuth, tagger agent, staff notice |
| 6 | Policy sign-off, AI consent, location tracking | Partly built | Y | Adviser review of notice, 14 days' notice, job lat/long |
| 7 | SMS and calls via Twilio | Not started | Y | Native app (3), Telstra port (Twilio bundle approved) |
| 8 | invoice@ supplier bill intake agent | Planned, waiting on owner answers | N | invoice@ alias in Google Workspace, which mailbox it sits on |

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
- New page. Not the same as `assets.html` (customer assets) or `fleet.html` (vehicles). Not started.
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

**Dependencies:** team chat channels (feeds exist, see AI_AGENTS_PLAN.md); tagger agent; user's AI start date (item 6). Users without one send audio only, no AI transcription.

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

**Open questions**
- [ ] Replies to tagged threads auto-tag to the same job? (probably yes)
- [ ] User disconnects: tagged emails stay on the job? (probably yes, business records)
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
- No AI start date: chat messages excluded from tagger, assistant, summaries, digests; email cannot be connected; voice messages not transcribed. Manual job tagging still works.
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

**Goal:** suppliers email bills to invoice@thomsonenergy.com.au (a Google Workspace alias, not a mailbox). An agent pulls each bill out, reads it and attaches it to the right PO, so nobody uploads bills by hand.

**Built today (reused):** sales@ Gmail sync (`_shared/gmail-sync.js`, every 5 min), supplier invoice extraction (`extract-supplier-invoice.js`), supplier matching (account number > ABN > bank > name), PO auto-match on the invoice's own order reference (`supplier-detail.html`), `supplier_bills` with `po_id`.

**Plan (proposed 18 Oct 2026):**
- Google: add invoice@ as an alias on sales@ (already connected to TEops), so no new OAuth or seat.
- Scheduled function every 5 min: Gmail search `to:invoice@thomsonenergy.com.au has:attachment`, label processed mail `TEops/Bill processed`; invoice@ mail is hidden from the Sales inbox tab.
- Per PDF/image: extract (same prompt as A11), match supplier, de-duplicate on supplier + bill number, save file to storage, create the `supplier_bills` row.
- PO matching, in order: PO number on the bill > PO number in subject/body > same supplier open PO with matching total (within $1) > line match. Confident: linked and logged on the PO. Not confident: goes to a new "Bills to check" queue with the top 3 PO guesses, one tap to confirm.
- Never approves for payment or pushes to Xero; a person still approves.
- Starts on staging, then read-only on production (suggest only) for 2 weeks before auto-linking.

**Owner answers 18 Oct 2026:** only supplier bills come to invoice@ ("Hola Supply" was voice typing for "only supply"). invoice@ currently delivers to jasper@, accounts@ and jade@. Owner does not want sales@ cluttered; prefers TEops reads accounts@ if that avoids it.

**Open questions:** is accounts@ a real mailbox (user with a seat) or a group/alias; if not a mailbox, use sales@ with a Gmail filter (skip inbox, label Bills) instead.
