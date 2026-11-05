# TEops Ideas Backlog

Last updated 5 Nov 2026 (item 48 built)

Planned work not yet in docs/PROJECT_SPEC.md Part A. Code is the source of truth: if something here is built, move it to the spec.

## Status

| # | Item | Status | High lead time | Depends on |
|---|------|--------|----------------|------------|
| 1 | Payment reconciliation, receipts, tools register | Partly built | N | Airwallex read-only key, accountant sign-off |
| 2 | Voice messages in team chat + Siri Shortcut | Voice messages built with team chat (PROJECT_SPEC A19a), Siri not started | N | Personal tokens for the Siri Shortcut |
| 3 | Native iPhone app (TEgo, Capacitor) | Stage 1 built, waiting on Apple | Y | Apple Developer enrolment approval, then `docs/IOS_APP.md` setup; offline sync design for stage 2 |
| 4 | Weather-aware scheduling worker and Weather page | Not started | N | Job lat/long (not stored today), work type field |
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
| 27 | Quote in steps: create, pre-quote info, site visit, pricing, scope of works, send; STC and BSTC credits at quote level | Built 21 Oct 2026, LIVE (spec A3), migration 20261117000000 | N | None |
| 31 | Simpler purchase orders (short list, one PO page, tick-to-receive, short Create panel, Show me how tour) | Built 23 Oct 2026, LIVE once merged (spec A10) | N | None |
| 36 | Software factory: isolate, build, prove, ship, weekly cleanup (`docs/SOFTWARE_FACTORY.md`) | Built 27 Oct 2026, on `staging` | N | Owner: allow `*.netlify.app` on the cloud environment so phone sessions can run the smoke run |
| 37 | One brain, many workers: see everywhere, event routing, Postie filing and learning, My Plan, enquiry to draft quote (`docs/AI_AGENTS_PLAN.md`) | Step 5 (Postie filing) built 27 Oct 2026, on `staging`; rest waiting on yes | N | Owner's yes to remove the 4 wrong labels on production; staff notice for per-person email |
| 40 | Delete and Already paid buttons on the Emailed bills page | LIVE 4 Nov 2026 (spec A11), migration 20261128030919 | N | None |
| 44 | Scan a part into Stock (photo of part number or barcode), one price per supplier from price lists and bills, ask to match | LIVE 4 Nov 2026 (spec A12, A11b), migration 20261128050000 | N | None |
| 46 | Charge rates per client and per job (Standard, Commercial 115%, Mates rates 85%...) applied to quotes, variations, invoice actuals and the Schedule of Rates | LIVE 4 Nov 2026 (spec D1a), migration 20261128070000 | N | None |
| 48 | Commercial agreements: a builder's % off the Schedule of Rates, sent as a letter, shown on invoices as full rates then the agreement line, withdrawn in one click | Built 5 Nov 2026 (spec D1a), migration 20261128090000, straight to `main` on the owner's say | N | None |
| 47 | Merge a client's jobs into one job, each old job a cost centre, old J numbers still work | LIVE 4 Nov 2026 (spec A13e), migration 20261128080000 | N | None |

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

## 4. Weather-aware scheduling worker and Weather page (design agreed 28 Oct 2026, build waiting on the owner's yes)

### Design agreed 28 Oct 2026
- **Source:** Willy Weather API (BOM forecasts and BOM warnings, pay per call). Key in `api_keys` (`willyweather`), read with `get-integration-key.js`. Open-Meteo only if hourly detail proves thin.
- **No twice-daily pull of every job.** Forecasts are fetched on demand (opening the Weather page, the schedule week view, or dropping a job on a day) and cached per Willy Weather location for 3 hours in a `weather_cache` table (location id, fetched_at, forecast json, warnings json). Jobs that resolve to the same Willy Weather location (suburb or town, BOM's own grouping) share one forecast; no 50 km radius maths. A call takes roughly half a second through the Netlify function.
- **One morning sweep** (`sweep-weather.js`, 6am Sydney, pg_cron) over jobs booked in the next 3 days, so a change (rain chance jumps, wind or heat warning) pushes "Thu J7006 roof install now 80% chance of 15mm, suggest swapping with indoor J7010" to the booker and the ops manager. This is the only scheduled pull. Tens of calls a day at most.
- **Job lat/long:** `projects.lat`, `projects.lng`, `projects.weather_location_id` saved from the existing Google Places autocomplete on the job address (`project.html` `p-address`, add `geometry` to the fields) and backfilled once by geocoding existing addresses.
- **Weather page** (`public/weather.html`, Team menu, every signed-in user): search a job (J number, client or address, the same picker as elsewhere) or type a suburb, and it shows that area's 7-day forecast (rain chance and mm, wind, min and max, UV) with BOM warnings on top, rain/wind/heat flags against the roof and heat limits from Settings, and the jobs booked there in the next 7 days. Defaults to the user's next booked job. Pull to refresh re-fetches past the cache.
- **Job Schedule tab** (owner, 28 Oct 2026, phase 1): each booked day in the job's Schedule tab (`js/job-schedule.js` on `project.html`) shows that day's forecast for the job's site (icon, rain chance and mm, wind, max) with a rain/wind/heat flag against the Settings limits, from the same cache. A "Full forecast" link opens the Weather page on that job.
- **Schedule page:** rain/wind/heat icon per day on `schedule.html`, from the same cache (phase 2).
- **Phases:** 1 lat/long plus Weather page plus job Schedule tab forecast plus cache (ships alone); 2 schedule page icons plus morning sweep plus alerts; 3 booking guard through the scheduling agent (suggestions only).

Touches: `public/weather.html` (new), `netlify/functions/weather-forecast.js` (new, `requireActiveUser`), `netlify/functions/_shared/weather.js` (new), `netlify/functions/sweep-weather.js` (new, phase 2), `public/project.html` (save lat/lng), `public/js/job-schedule.js` (forecast per booked day), `public/schedule.html` (phase 2), `public/settings.html` (thresholds, phase 2), `public/js/supabase-client.js` (nav item), one migration (`projects.lat`, `lng`, `weather_location_id`, `weather_cache` table with fast RLS, pg_cron in phase 2). Overlaps: none on main or staging; item 37 touches `settings.html` later (phase 2 only). Kind: feature (into `staging`); migration yes; money, stock, RLS or payroll: RLS yes (new table). Size: phase 1 medium, phase 2 medium. Test on staging: any staff login, Team, Weather, search J7006, see the 7-day forecast and the booked jobs; needs a Willy Weather key in the staging `api_keys`. Best model: Opus 5.5, effort high, because it is a feature build with a known design and one small migration.


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

28 Oct 2026 recommendation (waiting on the owner's yes): **Willy Weather API** first. BOM forecasts for 17,000 Australian locations plus official BOM warnings in the same API, pay per call (our volume is roughly 2,000 calls a month, a few dollars at most; confirm on their cost calculator, the published rates are old), lat/long resolved to a location ID with one search call. Open-Meteo (BOM ACCESS-G and other models, hourly, 16 days, fixed monthly commercial fee, free tier is non-commercial only) as the second source if Willy Weather's hourly detail is thin. Ruled out: Early Warning Network (earlywarningnetwork.com.au), a quote-priced alerting service for councils, mines and insurers; we need a per-site forecast feed, not meteorologist alerts. BOM direct feeds: free but FTP/XML, not for third-party API use, and the 2025 site rebuild broke integrations.

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

**23 Oct 2026:** the sweep of the app itself was run (read only) after the week of updates: `docs/BUG_REVIEW_2026-10-23.md`, 195 confirmed findings. Fixed in three consolidated deliveries (owner's yes 24 Oct, straight to `main`): delivery 1 (database lockdown, migration 20261124131544, PR 213, live 24 Oct), deliveries 2 and 3 (functions, money, payroll, leave balances, pages, migration 20261124150000, PR 214). Status per row in `docs/DECISIONS.md`. The account-side items below (2FA, idle lock, re-enter password, leaked password protection, backup restore test) are still to do.

**Small leftovers from the sweep (not built, owner's yes needed):** `chat_messages.ai_attempts` so a chat message the AI failed on twice is not retried forever (F35); a partial unique index on `knowledge_read_jobs` so one entry cannot get two running reads (M21); `get_invoice_balances(uuid[])` so the Invoices page fetches every balance in one call instead of one per invoice; the Timesheets day editor still builds its day window from the device time zone (F51, wrong only on a phone set outside Sydney). Touches: one migration each, `public/invoices.html`, `public/timesheets.html`.

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


## 16. Build rule checks in `npm run check` (decided against 19 Oct 2026, partly reversed 27 Oct 2026)

27 Oct 2026: owner said yes to two automatic checks, dead code and page weight, as part of the software factory (item 36). Style rules stay manual. The rest of this item stands.

Owner's call (19 Oct): no automatic checks. Instead a whole-site review pass (like `docs/BUG_REVIEW.md`) after each big chunk of features is added; the build rules in `CLAUDE.md` guide each build.

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

## 27. Quote in steps: create first, then pre-quote info, site visit, pricing, scope of works, send; STC and BSTC credits at quote level (built 21 Oct 2026, migration 20261117000000)

Live: see `docs/PROJECT_SPEC.md` A3 "Quote in steps". Built as planned (points 1 to 7, point 5 in the two-lines-same-account form). The plan as agreed follows.

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


## 28. Schedule month view: equal columns, fixed cell height with scroll, one chip per job (built 21 Oct 2026)

Found from the owner's photo of the October 2026 month view: columns come out uneven (Sun, Fri and Sat squeezed narrow, Mon to Thu wide) because the grid uses `1fr` columns, and busy days grow the row because cells have a minimum height and no maximum.

Built, one file (`public/schedule.html`), no migration. Chips wrap onto two lines rather than truncate so the names stay readable:

1. Equal columns (`minmax(0, 1fr)` and `min-width: 0` on the cell) so every day is the same width.
2. Fixed cell height (about 120px desktop, 80px phone). The chip list inside scrolls when it overflows, with a faint fade at the bottom. The whole cell still clicks through to Day view.
3. A muted booking count next to the day number (for example "21 · 7").
4. One chip per job per day ("J7004 Florist power relocation · Guy, Casey") instead of one per person. Leave chips stay per person.

Confirmed the same day, how the schedule and timesheets relate (no change planned unless the owner asks): both views show bookings (`schedule_assignments`) only. A time entry never creates a booking. On past days, Day view locks a booking to its real clocked times when there is matching clocked time, and removes a booking nobody clocked on to. Clocked time with no booking (for example a timesheet added later because someone forgot to log in) shows nowhere on the schedule. Possible follow-up if wanted: show it on past days as a grey "worked, not booked" block.

## 29. Electricity bill reader on the quote: all pages, read by AI, solar and battery sizing, savings on the proposal (built 22 Oct 2026, migration 20261118000000)

Owner's report: the bill upload on quotes takes one page when bills run 3 to 6 pages, and the AI does not read the page that is uploaded. Found:

- The "Documents to gather from the customer" checklist on step 5 (Send) has an "Electricity bill" photo item that keeps one file only (the input is single-file and only the first upload is saved, `quote_compliance_answers.photo_path`), lands in the public site-photos bucket, and no AI ever reads it.
- The "Supporting documents" on step 4 (Scope of works) take several files and PDFs and the AI does read them, but only to word the scope, and the list is thrown away on every page load (`sowDocs = []`), so a bill attached yesterday is not there today.

Plan (one delivery, migration plus code):

1. **Electricity bill card on step 1 (Pre-quote information)** for Solar and Battery quotes: upload several photos or a multi-page PDF (phone camera or files), stored privately in `project-documents` under `bills/<quote id>/` and listed as `project_documents` rows in a new folder "Electricity bill" (so they show on the Documents tab too). Each page is listed with Remove; more pages can be added later.
2. **Read bill with AI** (new `read-electricity-bill.js`, pricing roles): every page goes to the model in one call; it returns a fixed JSON: retailer, NMI, billing period and days, total kWh, daily average, peak / shoulder / off-peak and controlled load kWh where shown, solar export kWh and feed-in rate, usage rates c/kWh, daily supply charge, bill total, and anything that hints at supply (single or three phase, existing solar). Saved on `projects.bill_reading` (jsonb) with who ran it and when.
3. **Sizing worked out in code, not by the model** (deterministic, shown on the card with the inputs so it can be checked):
   - Solar: daily use divided by the zone's yield (about 3.9 kWh per kW per day in zone 3, 4.2 in zone 2), less any existing solar, rounded up to a common size (6.6, 8, 10, 13.2 kW), with the export limit answer noted.
   - Battery: the kWh used outside solar hours (the off-peak plus shoulder share when the bill splits it, otherwise 60% of daily use), plus the backup needs answer, rounded up to common sizes (10, 13.5, 16, 20 kWh), kept inside the 5 to 100 kWh federal discount band.
   - A plain one-line summary of the bill and an "estimate only" note; no money promises.
4. **Fills the answers**: NMI, daily use, supply (phases) and existing system fill their pre-quote questions when blank; suggested solar kW prefills the STC system size on step 3 and the battery kWh prefills "Usable kWh wanted" when blank. The reading is included in the scope of works prompt.
5. **Fixes alongside**: every checklist photo item on step 5 (bill, owner consent, strata) accepts several files (`quote_compliance_answers.photo_paths` jsonb, thumbnails for each); the bill item answers itself Yes when step 1 has pages. Step 4 supporting documents are saved on `projects.sow_documents` (jsonb) so they survive a reload, and the bill pages are passed to the scope of works too.

Migration: `projects.bill_reading jsonb`, `projects.sow_documents jsonb`, `projects.show_roi boolean`, `quote_compliance_answers.photo_paths jsonb`; `get_quote_by_token` returns the bill reading, the system size, the zone and the few answers the savings page needs. No money or stock change.

Added with the owner's yes (22 Oct 2026): **the proposal shows the return on investment.** A "Your savings" page on Solar and Battery proposals, between Your system and the Investment summary, from the bill reading and the quote: use now and bills now, solar generated, stored for the evening, used at home, sent to the grid, bought from the grid after, estimated bills after, estimated saving a year, the investment after the credits, payback years, yearly return, 10 and 25 year savings (prices up 3% a year, panels down 0.5% a year), emissions avoided, and the assumptions in a note. The maths is one shared file (`public/js/solar-roi.js`: the sizing, the scenarios with and without the system, the rows and the assumptions text) used by the quote page preview, the proposal and the reader, so staff and client see the same figures. Caps keep it honest: panels cover at most 90% of daytime use, the battery at most 80% of evening use over a year. The solar size is the quote's STC system size (or the Pylon design), the battery size the "Usable kWh wanted" answer, the price the total after the STC and BSTC credits. Step 3 has a tick "Show the savings estimate on the proposal" (on by default).

**Missing information (owner, 22 Oct 2026): warn us, never guess, never block sending.** `roiGaps()` lists what is missing and `roiPresentation()` decides what shows: no bill read, no usage in kWh, no usage rate, no bill total, solar export on the bill (or a Battery quote) with no existing solar size, no system size, no battery size, no price. The bill card on step 1 shows them in a red box with what the proposal will ask the customer for. The proposal still goes out and its Your savings page shows the rows we can stand behind: with rates and a total, everything; no rates or total, the kWh rows only (no dollars); no existing solar size, use and bills now only; no bill, no rows. Under the table, "What we still need from you": one line per item, "To give you Y, we need X" (the usage page, the rates page, the total page, a full quarterly bill, the existing system size in kW), then "send it to us and we will update this proposal; if you accept this proposal before we have it, you are accepting it on the figures and information shown here". Gaps only the office can fill (size, price) just leave their rows off. Warnings (a bill under 28 days, no supply charge, no time-of-use split) keep the figures with the assumption declared. Nothing in this touches the ready-to-send gate.

**Recommend, then quote, then estimate (owner, 22 Oct 2026, migration 20261119000000).** The bill card separates "Recommended from the bill" (the sizes the reading suggests, with "Quote this size (step 3)" buttons) from "Savings estimate on what we are quoting": the estimate runs only on the quote's own figures, the STC system size (kW), the new `projects.battery_kwh` (battery quoted, usable kWh, a field in the STC and BSTC credits block on step 3 under "What we are quoting"; falls back to the "Usable kWh wanted" answer) and the total after the credits. **Charts:** the proposal's Your savings page (and the step 1 preview) carries three small inline SVG pictures from `roiChartsHtml()`: Your yearly bill (two bars, now and with the system), Where your power will come from (one bar split into straight from the solar, from the battery at night, still from the grid, with percentages), Savings add up (cumulative savings over 25 years against the investment line, the paid-off year marked, the 25 year total labelled). Only the power chart shows when the dollar figures are withheld. Solar blue, battery green, grid grey; direct labels, no legend boxes, one axis. Kept deliberately simpler than Pylon.

**Taking it off a proposal (owner, 22 Oct 2026):** the tick "Show the savings estimate on the proposal" is on step 3 (saved with Save pricing) and on the step 1 bill card (saves straight away, regenerates the PDF). Off: the whole Your savings page goes, charts, table and the "what we need" note alike.

**Rework built (owner's yes 23 Oct 2026, migration 20261120000000): solar first, then the battery, on the bill's rates, with other rates and battery export to compare.** Built as planned below; the maths is now an hour-by-hour typical day in each of four seasons (70% clear days, 30% overcast) with a normal household load shape stretched to the bill's peak / shoulder / off-peak split, `roiEstimate()` in `public/js/solar-roi.js`; the bill card has a Rates for the estimate panel (tariff, rates, hours, controlled load, supply, feed-in; a second plan; the export window; Save rates), step 3 has Solar price and Battery price, the staff see the working under "Show the working" (each stage's kWh and bill on each plan, and a check of the modelled bill against the real one). Inputs live on `projects.roi_inputs`. Original plan: Today's maths is one blended usage rate, one 40/60 day and night split, and solar plus battery treated as one system against one price (working shown in chat 22 Oct). The rework:

1. **Rates we can change.** The bill card gets a rates panel prefilled from the bill: usage rate (flat, or peak / shoulder / off-peak with their hours when the bill is time-of-use), daily supply charge, feed-in rate. A second column "If they switch to [retailer]" with the same fields, typed by us, optional. Saved on `projects.roi_inputs` (jsonb, one new column). The proposal shows both columns when the second is filled ("on your current plan" and "on [retailer]").
2. **Solar first.** Generation from the quoted kW and the zone yield, netting any existing solar. Daytime self-use against the daytime load (from the time-of-use split or the default), the rest exported at the feed-in rate, the import priced at the rate for its time of day. Solar saving = bill before less bill after; solar payback on the solar price.
3. **Then the battery, from export and import.** The battery charges from what solar would otherwise export (so the lost feed-in is counted), and discharges into the evening and overnight import at that time's rate (peak when the bill is time-of-use). Battery saving = the extra over solar alone; battery payback on the battery price. Together: total saving, payback, 10 and 25 years, with the battery's own line.
4. **Battery export to the grid.** Optional: "export from the battery at X c/kWh between HH:MM and HH:MM, up to N kWh a day" (a retailer or VPP that pays a high evening feed-in). The battery sends that energy to the grid at X instead of covering the home's evening use when X is higher than the evening rate; the rest covers the home as in 3. Shown as its own line.
5. **Two prices on step 3.** "What we are quoting" gets Solar price (inc GST, after the STC credit) and Battery price (inc GST, after the BSTC credit), prefilled from the stage each credit is claimed with, so each step has its own payback; the total stays the quote's total after credits.
6. **Proposal and preview:** the Your savings page becomes Solar, Adding the battery, Together (and the retailer comparison column when set); charts become yearly bill now / with solar / with solar and battery, where the power comes from, savings adding up (one line for the total, the solar-only payback marked too). The working (each step's kWh and dollars) is shown on the bill card so it can be checked.

**Only the quoted battery counts (23 Oct 2026, from Q1005 and Q1008):** the estimate's battery is the "Battery quoted (usable kWh)" on step 3 and nothing else; the "Usable kWh wanted" answer (what the customer asked for; on Q1005 it held the daily use, 179.2) is never used. No battery typed: the estimate runs without one and the bill card says so (type it, or answer "Batteries as well?" No on a solar-only quote). Battery sizes recommended now go up to 100 kWh in 10 kWh steps, with a note when the need is bigger (commercial, sized by hand). **Second quote for the same client** (a with-battery and a without pair): a quote with no bill pages offers "Use the bill from Q...", which copies the pages, the reading and the rates (not the prices) from the client's other quote.

**Fixes from Q1005 (23 Oct 2026):** a blank bill field was read as 0 (so a bill with no feed-in priced every export at nothing, and a missing bill total looked like $0); a two-band tariff (peak and off-peak only, CovaU on Essential Energy) was given a made-up shoulder band whose hours had no kWh on the bill, which zeroed the daytime load and starved the solar; both fixed (a shoulder band exists only when the bill or the staff has one, and the day shape is only stretched when the bill's bands and the plan's hours line up). The battery quoted is read off the quote's own line items when step 3 is blank (6 x "Sigen Battery 8kWh" = 48 kWh, shown as the grey hint). The reader now also asks the bill for the time-of-use windows (`tou_hours`), used as the default peak and shoulder hours; the shoulder hours field blank means no shoulder band.

**Built (owner's yes 23 Oct 2026, no migration): user friendly and hard to get wrong.** As planned below, with these calls made while building: the solar size stays a step 3 change (it also sets the STC credit), shown on the card with "change on step 3" and an amber "not saved yet" line when step 3's box differs from what is saved, and "Quote this size" for solar puts the size in step 3's box and jumps there; the battery and the two prices save themselves from either place. The two prices default to a split that always adds up to the total (the battery stage less the BSTC, solar the rest; `roiDefaultPrices`), so each gets its own payback with nothing typed; typed prices are checked against the total. The rates panel stores only what was changed from the bill (`roi_inputs.current`), so untouched boxes always follow the bill; a fresh read asks before replacing hand changes. Bill figures changed by hand are kept with what the AI read (`bill_reading.edited_fields`, `ai_values`). Zero or negative days or kWh count as not on the bill; a bill total below zero (in credit) is allowed. Staff checks live in `roiChecks()`. The preview charts sit on a white panel as they print, and the payback label sits under the savings chart so it never collides with the line. Duplicate as new quote now also carries the quote-level STC and BSTC credits (pointed at the copied stages), which it had been dropping since item 27. New ready-to-send rule: a BSTC credit on a quote with no battery fails (a copy keeps the original's credits). Plan as agreed:
1. **One card does the lot (step 1).** Bill pages, Read, the rates, what we are quoting (solar kW, battery kWh, solar and battery prices, mirrored with step 3 and kept in sync), the estimate and the proposal switch, all on the bill card, so nobody hops between steps to see a change. Everything on the card saves itself as it is changed (a small "Saved" tick), no Save buttons to forget; the PDF regenerates after. Step 3 keeps its fields; the "Quote this size" buttons save straight away.
2. **The reading can be corrected.** A "From the bill" row (days, total kWh, peak / shoulder / off-peak / controlled kWh, bill total, solar export) editable next to the rates, saved into the reading and marked edited, so a misread figure is fixed in place instead of worked around.
3. **Plain checks that catch mistakes**, in the same box as the gaps: a battery or solar size outside the usual range, a rate or supply charge outside the usual range, a bill shorter than 20 days or longer than 100, typed battery kWh that does not match the quote's line items, solar plus battery prices that do not add to the total, a payback under 1 year or over 25, and the modelled bill more than 20% off the real one; each says what to check.
4. **Simpler rates panel.** The main numbers first (tariff, rates, supply, feed-in); hours, controlled load, the second plan and the export window under "More".
5. **Step 5 says where the proposal stands.** Under Check now: "Savings page: on, 2 things to check" (listed, linking to step 1), or off; the ready-to-send gate's battery size rule reads the battery quoted (step 3), not the "wanted" answer.
6. **Duplicate as new quote carries the bill** (pages, reading, rates, sizes and prices) so a with and without pair starts from the same facts; the "Usable kWh wanted" answer becomes optional and is labelled as what the customer asked for.
7. **Words:** the card explains itself in three lines (add the bill, read it, type what you are quoting) and every warning says what to do, not just what is wrong.
No migration (the reading's edited fields live in `bill_reading`; everything else has its column).

**Time of use times done properly (owner, 23 Oct 2026, no migration): off-peak is not always at night.** Each plan now has windows: a band (peak, shoulder, off-peak, or solar soak where a plan prices a cheap midday window on its own), hours, days (every day, weekdays, weekends) and months (blank for all year), plus "any time not listed is". Where two windows cover the same hour the narrower wins and a check says so. The reader asks the bill for every window as printed (`tou_schedule`, `tou_other`, `solar_soak` rate and kWh), including midday and weekend off-peak, and never assumes one. The estimate runs every season, clear and overcast day, and weekday and weekend day separately, each hour priced at its own band; the day shape is fitted to the bill's kWh split across all of them. The battery keeps its charge for dearer hours still to come before the panels refill it (so it does not spend it in a cheap midday or overnight off-peak hour while peak is ahead) and carries what is left into the next morning. On the bill card, "When each rate applies" shows a coloured 24 hour strip per day pattern (weekdays, weekends, seasons where they differ) and the times in words; "Change the times" edits the windows, "These times are right" confirms assumed ones, "Use the bill's times" undoes hand changes. Times not on the bill are flagged as assumed (amber, on step 5 too) until typed or confirmed; a band that applies with no rate, or a rate that never applies, is flagged. The working lists the times and what the battery covered in each band. Older saved peak and shoulder hours still load.

**Night charging and spare solar (owner, 23 Oct 2026, no migration).** The battery step now shows how much of the battery the spare solar fills on an average day ("Filled by spare solar"), and a check fires when it is under 70% (with the share of days it fills it all), naming the options: more solar, a smaller battery, or night charging. New option under More, "Charge the battery from the grid at night on a cheap rate": window (default 00:00 to 06:00), charge rate (blank: the plan's rate then), kWh a day (blank: as much as it needs), saved as `roi_inputs.grid_charge`. In the window the battery tops up only as much as it needs for the dearer hours before the panels refill it, only when that is cheaper after battery losses, and never spends it in the same hour; the home runs on solar in the day and the battery covers the morning and evening. The proposal shows "Charged from the grid at night" (kWh, rate, cost) and the bill includes the charging cost; the working shows what night charging adds over spare solar alone (Q1005 at 15c: $6,082 to $8,195 a year); a check says when night charging does not pay.

Sizes stay suggestions: "Use as system size (step 3)" and "Use as usable kWh wanted" buttons fill the fields, then Save as usual. The Pylon "View interactive design & ROI" link stays as it was.

## 30. Post a site photo to the feed with a message and tagged people (built 22 Oct 2026, migration 20261119000000)

**Today:** the job feed and the company feed (`feed.js`) already do posts, @ tags with a notification (`feed_mentions`), likes, comments and "also show on the Home page". A post cannot carry a photo, and a site photo cannot be posted anywhere. (Owner, 22 Oct 2026: a separate tag-on-the-photo table was planned first and dropped; the tag lives on the post.)

**Plan:**

1. **Table `feed_post_photos`** (migration): `post_id` (FK `feed_posts`, cascade), `photo_id` (FK `project_photos`, cascade), `sort_order`, unique on post and photo, index on each FK. Fast RLS `to authenticated`: everyone reads; only the post's author adds; the author or Admin removes. No new notification: tagged people already get one from `feed_mentions`.
2. **Post to feed from a photo (`project.html` Site Photos tab and the lightbox):** a "Post to feed" button in the lightbox, and a Select mode on the tab to pick several photos then "Post to feed". Both open a small form: message, @ Tag people (same list as the feed composer), "Also show on the Home page" tick, Post. Makes one `feed_posts` row on the job, the mentions, and the photo links.
3. **Photos from the feed composer (job feeds):** an "Add photos" button on the job's Feed tab composer (camera or files). The pictures go through `uploadPhotosBatch` into site photos as now (so they stay on the Site Photos tab) and are attached to the post. Home-only posts (no job) stay text, as now.
4. **Feed cards (`feed.js`, job feed and Home):** a photo strip under the message (thumbnails, tap opens the lightbox with the set), tagged names as now. Deleting a post leaves the site photos alone; deleting a site photo drops it from the post.

No money or stock change. One small migration, `?v=` bumps on feed.js, supabase-client.js and project.html scripts.

As built: the post, tags and photo links are made in one database call, `create_feed_post` (security invoker, so the table policies check the caller). A post can be photos only with no message. Possible follow-ups: photos on Home-only posts (no job), and showing a post's photos as "on the feed" on the Site Photos tab.

## 31. Simpler purchase orders (built 23 Oct 2026, no migration)

**Why:** the owner finds purchase orders overwhelming. Read-only look at `purchase-orders.html`, the job page Purchase orders tab (`project.html` `loadPurchaseOrders`, `openCreatePoPanel`) and the shared card code in `supabase-client.js` (`renderPoLineItemsReceivable`, `renderPoControls`, `renderPoBills`) found:

1. **Everything is open at once.** The list loads every PO ever made with every line and every bill line, filter defaulting to All (UX 121 never shipped). Each card shows all its lines, each line with up to five buttons (Receive, Mark backordered, Move, + Add to Stock, Tool?), the notes, every bill with its lines and Accept / Deny / Undo buttons, then up to nine PO buttons (+ Add item, Edit lines, Email PO, View PO, Notes, Prices on PO, Close PO, Upload invoice, View log). A ten-line PO is over fifty buttons on one card and the page is a wall of them.
2. **No place to look at one PO.** `?id=` from the top bar search is the only one-PO view; the job page repeats the same wall per job.
3. **Receiving asks a question it already knows the answer to.** Each line opens a panel asking "Send to" when the answer is nearly always the PO's own destination. Receive all exists on job POs only.
4. **The Create panel asks for everything up front.** Destination, tools kind and place, job, where from, supplier, upload-invoice-instead, fixed or open PO, lines, supplier notes, internal notes, show prices; on the job page also stage, description, budget cap and attach a document. Most are rarely used. After Create nothing says which PO number was made or offers Email now (UX 134).
5. **Two sets of words.** Badges say Ordered / Part received / All received / Closed; the filter says Pending only / Received only / Ready to close / Open / Closed, mixing the received and closed axes; the three tiles mix money and counts.

**Plan (one delivery, no migration):**

1. **Short list.** `purchase-orders.html` becomes one row per PO: PO number, supplier, where it is going, total, one status chip, "3 of 8 received", and a red dot when a bill line needs a decision. Tap a row to open the PO. Loads open POs only (lines and bill counts, not bill lines); Closed loads when asked for. Tabs instead of the six-way select: **Open**, **Ready to close**, **Closed**; search stays. Three tappable tiles: Waiting on delivery, Ready to close, Bills needing a decision (counts, same words as the tabs).
2. **One PO, one page.** New `purchase-order.html?id=` (the top bar search and the job page link to it). Header: PO number, supplier, destination, status, total. One big **next step** button that changes with the state: Email to supplier (never emailed, from the activity log), Receive (something ordered), Close and approve (all received), Decide on bill lines (a red bill line). Lines as a plain list with a tick box each; per-line extras (Backorder, Move, Add to Stock, Tool) under one small "..." per line. PO extras (Notes, Prices on PO, View PDF, Edit lines, Add item, Upload invoice, Log, Reopen) under one **More** menu. Bills in their own section, folded unless a line needs a decision. Notes shown only when there are notes.
3. **Tick to receive.** Tick the lines that arrived (Select all), then one button "Receive N to J7040" (or to Stock, the van, the Tools register), the destination preset from the PO; a small "Somewhere else" link opens today's panel for the odd line. Same on job, Stock, vehicle and Tools POs, one `po_receive_line` call per line as `receiveAllPoLines` does now.
4. **Short Create panel.** What is it for (Job / Stock / Vehicle / Tools) and supplier, then lines. Everything else under one **More options** fold (open PO, stage, description, notes, prices shown, budget cap, attach a document, upload the invoice instead). After Create: "PO1234 created for Supplier" with **Email it now** and **Open it**. Same panel on the job page, Stock and vehicle pages.
5. **Job page Purchase orders tab** shows the same short rows linking to the PO page, with Create PO and Suggest POs as now.
6. **One set of words** everywhere: Ordered, Part received, All received (ready to close), Closed.

No money or stock rule changes: every receive, move, close and bill decision keeps calling the same database functions. Files: `purchase-orders.html`, new `purchase-order.html`, `supabase-client.js` (shared row, next step, tick-to-receive), `project.html`, `stock.html`, `vehicle-stock.html`, `global-search.js`, `style.css`, `?v=` bumps. Roles unchanged (staff receive, pricing roles edit lines and decide on bills, Admin / Finance reopen).

**As built (23 Oct 2026):** everything above, plus the owner's add-on the same day: a **Show me how** guided tour for new staff on the Purchase Orders page and the PO page (spotlights the real buttons step by step, offered once to anyone new, on the button any time). Tabs became Open / Waiting on delivery / Ready to close / Bills needing a decision / Closed. The supplier page and the Stock and vehicle pages show the same short rows. Detail in `docs/PROJECT_SPEC.md` A10. Possible follow-ups: a tour on the job page's Purchase orders tab; the Closed tab stops at the last 300 (search by PO number for older).

## 32. Notifications in three places: bell, Messages, ops manager (built 23 Oct 2026, migration 20261120000000)

**Today:** every notification kind lands in the one bell (`public/js/notifications.js`), pushes to the phone, and only disappears when tapped or "Mark all read". Opening an email in the Inbox or a chat does not mark its bell row read. The owner's bell on 22 Oct 2026: 79 unread, of which 45 emails, 13 emailed supplier bills, 7 Knowledge Base reads, 5 ops digests, and 9 real items (bookings, licences, a tag, a statement, a price list, a worker alert). Chats (16 rows) also land there. The Ops page `Needs me` card already lists emailed bills, bill checks, statements, price list changes and worker tasks from their own tables, so the bell rows for those are doubles.

**Plan:**

1. **Three channels, set from the kind in `create_notification`** (migration 20261120000000): new `notifications.channel` (`bell`, `messages`), a `notification_channel(kind)` lookup, backfill of existing rows, partial index on `(user_id, channel) where read_at is null`.
   - **bell** (do or know now): tag, comment, task_assigned, task_reminder, call_reminder, followup_done, scheduled, booking_reminder, review, licence, incident, knowledge, quote accepted, variation signed, ops_digest, agent_alert.
   - **messages**: chat_dm, chat_mention, chat_reply, chat_message, email.
   - **ops manager** (supplier_bill, price_list, statement, stock_low, bill problems): no row at all. They live on the Ops page `Needs me` card and in the 5am digest, which is the one bell item a day that sums them up. Stock running low is added to both (today it is only on the Stock page).
2. **Bell** counts and lists `bell` rows only. The tick-box list is grouped under Bell, Messages and Ops manager headings so people see where each thing goes.
3. **Messages icon** (the Chat icon in the top bar, `supabase-client.js`): badge = unread chats (as now, `chat_unread_total`) + unread `messages` rows for emails. Tap opens a small panel with two sections, Chats (unread chats, from `chat_my_channels`) and Emails (unread email rows), each row opening the chat or the Inbox thread. The Chat and Inbox menu entries stay as they are.
4. **Read when read:** opening a thread in the Inbox marks its email rows read (match on the link); `chat_mark_read` marks that chat's rows read. So the Messages badge drops as you work through them, and the bell is never touched by them.
5. **Tick boxes only for what you can get** (owner, 23 Oct 2026). The "Choose what I get notified about" list shows a person only the kinds their role can receive, grouped under Bell, Messages and Ops manager. Admin and Finance: everything their role gets. Sales: no supplier bill, price list, statement, stock low or incident boxes. Staff: those plus no shared inbox email box. The ops digest and worker alert boxes show only for people set as ops manager in Settings. Kinds that come from something the person did themselves (claimed call, a meeting they ran, a Knowledge Base read, a review on a job they made) show for everyone.
6. **Phone push** (`_shared/push.js`): bell rows push as now; chat DMs and @mentions push; emails, channel chatter and thread replies do not. The per-kind tick boxes still turn any of them off.
7. **One-off tidy on production** (owner's yes with the plan): existing email, chat and ops rows are marked read for everyone (the ops kinds deleted), so the bell starts at the real items. The owner's bell goes from 79 to about 19.
7. **One-off tidy on production** (done 23 Oct 2026): existing email and chat rows (575) marked read for everyone, the 72 ops rows deleted (copy kept in `notifications_tidy_20261023` for a few weeks), so the bell starts at the real items. The owner's bell went from 79 to 19.

**Decided while building (owner, 23 Oct 2026):** shared inbox mail notifies Sales and above (Admin, Finance, Sales), never Staff, and the Inbox menu entry is hidden from Staff to match. Staff still see emails linked to their jobs on the job page.

No money or stock change. One small migration; `?v=` bumps on notifications.js, supabase-client.js and the pages that reference it; ops-digest.js, push.js, inbox.html and ops.html change.


## 33. Contacts on every job: on site, client, Thomson Energy (built 23 Oct 2026, migration 20261121000000)

**Today:** a job can only link five of the client's saved contacts (`projects.project_manager_contact_id`, `site_contact_id`, `job_contact_id`, `sales_contact_id`, `accounts_contact_id`), picked in the quote edit form from `client_contacts`. That table is readable by pricing roles only, so Staff on site never see the "Who's running this job" card on the Details tab, and there is nowhere to put the owner, the renter, the builder or another trade, nor who at Thomson Energy is running the job. At clock-out, everyone on the job is asked "How's the job?" (Complete / Not complete, back next working day), whoever they are.

**Plan:**

1. **New table `job_contacts`** (migration 20261121000000): one row per person on a job (quotes too, same project id), `side` (`site`, `client`, `thomson`), `role`, `name`, `company`, `phone`, `email`, `notes`, `profile_id` (Thomson side, one of our people), `client_contact_id` (set when picked from the client's saved contacts), `sort_order`, `created_by`, `created_at`. One Thomson site manager per job (partial unique index). Fast RLS: every active user reads, adds, edits and removes (a tradie adds the builder's number on site). Indexes on every FK. Backfill: the five existing links on every job and quote become client-side rows.
   - **On site** roles: Owner, Renter, Builder, Other trade, Real estate agent, Strata, Other.
   - **Client** roles: Project manager, Site manager, Job contact, Accounts, Sales, Other.
   - **Thomson Energy** roles: Site manager, Project manager, Sales manager, Other.
2. **Contacts tab on the job page** (`project.html`, every role, after Summary): three sections with an Add button each. On site and Client rows take role, name, company, phone, email and notes; the Client section also offers "Pick from the client's saved contacts" for pricing roles (fills the row and links it). The Thomson Energy section picks an active staff member and a role. Edit and Remove on each row, tap to call and email, an activity line on add and remove. The old "Who's running this job" card and the edit-form pickers go (their rows are carried into the tab). Quote contacts copy onto the job when the quote becomes a job (`create-job-from-quote.js`).
3. **Summary tab** gets a short "Key people" line: site contact, client site manager and Thomson site manager with tap-to-call, so a tradie never hunts for the number.
4. **Booking emails** (`_shared/schedule-emails.js`): the recipient is the job's first client-side contact with an email (Job contact, then Site manager, then Project manager), else the client's email as now.
5. **Clock-out** (`supabase-client.js`): the "How's the job?" step goes to one person a day per job. If the job's Thomson Energy site manager clocked in on it that day (Sydney date), only they are asked. If not, the highest-ranking person who clocked in on the job that day is asked (owner's change, 23 Oct 2026). Rank: new `profiles.site_rank` (1 is most senior, set on the Staff page, shown as "Site rank"), defaulting from the role (Admin 1, Finance 2, Sales 3, Staff 9), ties broken by who clocked in first. "Not complete" gets a day picker (next working day preselected, any day in the next 7, the window `book_back_after_clockout` already allows). Only that person's own booking is made; the crew stays with the PM to schedule.

No money or stock change. One migration (`job_contacts`, `profiles.site_rank`); `?v=` bump on supabase-client.js and staff-editor.js; project.html, staff.html, schedule-emails.js and create-job-from-quote.js change.

## 34. Retail plan suggestions from the AER's official plan data (built 23 Oct 2026, migration 20261123033219)

**Built (owner's yes, 23 Oct 2026).** `energy_plans` and `energy_plan_sync_runs` (staff read, server writes). `sync-energy-plans.js` runs every 15 minutes and starts `sync-energy-plans-background.js` when the last good download is over 20 hours old (a run that ran out of time carries on at the next tick, a failed one retries in an hour); the download finds every energy brand on the CDR register (a fixed list of AER brand paths if the register cannot be read), lists each brand's current electricity market plans, keeps residential and business plans on the NSW and QLD networks (Essential Energy, Ausgrid, Endeavour Energy, Energex, Ergon Energy; not the ACT's Evoenergy, owner 23 Oct 2026: licensed in NSW and QLD only), fetches only new or changed plans in full and converts each (`_shared/energy-plans.js` `convertPlan`) into the savings estimate's terms: rates and supply inc GST, time of use windows with days and months, controlled load, the retailer's lowest solar feed-in, guaranteed discounts and recurring membership fees applied, conditional discounts, other fees and eligibility kept as things to check; plans with demand charges or wholesale pricing are kept but not costed. Each run logs counts, errors and raw samples. On the bill card, "Other plans in this area (a suggestion only)": postcode (from the bill's supply address or the site), network, homes or businesses, Find plans; the plans are costed on this home's use with and without the quoted system (`roiComparePlans`, the same day shape for every plan), cheapest with the system first, with the current plan on the same basis; up to 3 ticked go on the proposal as a snapshot (`roi_inputs.plan_options`). The proposal's Your savings page then shows "Plan options in your area (a suggestion only)": each plan's estimated yearly bill with the system, against the current plan estimated the same way, the feed-in, things to check, the plan ID to look up on Energy Made Easy, and the owner's disclaimer (a suggestion to help their research; no endorsement; we cannot connect them with a retailer or switch them; no payment or commission from any retailer; the rates are an online estimate we cannot promise). A check flags plan options over 30 days old. Also fixed with it: a second plan in the estimate is now priced on the home's usage pattern from the bill's own times, not reshaped by the other plan's times. The parser follows the CDR energy standard; the first live download's samples are checked against it.

**First live download (23 Oct 2026, 04:30 to 04:34 UTC):** 6,235 plans from 20 retailers, no errors; the raw samples match the standard (some retailers write `dailySupplyCharge`, handled). Checked: AGL's Essential Energy time of use plan came through as peak 07:00-10:00 and 15:00-22:00 with off-peak 10:00-15:00 and overnight. 1,206 plans have demand charges and are not costed. A search for 2483 (Billinudgel, Essential Energy, homes) finds 832 plans from 16 retailers, 753 costable. Fixed after it: Amber's plans had been costed as an ordinary flat rate; wholesale-price retailers (Amber, Localvolts, Flow Power, Powerclub) are now never costed (stored rows fixed at once), a converter version on each plan makes the next download convert every stored plan again after a parser change, and the run log now says why the CDR register lookup fell back to the built-in retailer list (it did on the first run, so retailers missing from that list, such as Engie or Lumo, may be absent until the register is read).

**Options raised 23 Oct 2026 (owner chose: C later, backlogged as item 35; no wholesale estimates for now): wholesale retailers and business plans.** Business plans are already covered ("Plans for: Businesses", picked by default for a company client; 2483 on Essential Energy: 600 business plans from 13 retailers, 563 costable), with two limits: published plans are for small customers (under 100 MWh a year in NSW and QLD; bigger sites get negotiated contracts that are not published), and business demand-tariff plans are not costed. Wholesale retailers (Amber, Localvolts, Flow Power, Powerclub) are downloaded but left out of the list. Options: (A) list them under the table as "price follows the wholesale market, no estimate", tickable onto the proposal with that wording (small); (B) cost them with the retailer's own published estimate rates (small, but those are averages, often with no feed-in, and miss the battery's gain from price spikes; label it as the retailer's own estimate); (C) a proper estimate: AEMO's past half-hourly prices for NSW and QLD (public, a monthly download), plus each network's published network tariff (a small table updated every 1 July), plus the retailer's published fees, run through the same hour-by-hour model and shown as a range over the last 2 or 3 years (bigger build; the battery's gain from price spikes is the hardest part to estimate honestly). Recommended: A now, C only if wholesale plans matter for enough battery sales. **Decided 23 Oct 2026:** C is backlogged as item 35. Until then the app says "We don't do estimates for wholesale rates": on the bill card's plans section (with the count of wholesale plans sold at that postcode, apart from the demand-charge ones) and in the plan options note on the proposal (`ROI_WHOLESALE_NOTE` in `public/js/solar-roi.js`).

Original plan:

Owner asked for an agent that searches plans for the customer's address and recommends retailers. Assessment: worth doing, but not as an AI web search (retail plan pages change daily and an AI reading them would invent or misquote rates). Every retailer must publish its plans through the Consumer Data Right; the AER hosts that data publicly (Energy Made Easy's source, `cdr.energymadeeasy.gov.au/<brand>/cds-au/v1/energy/plans`, no login). Use that, and work the costs out with our own maths.

1. **Nightly plan sync** (scheduled function, new table `energy_plans`): every retailer's current residential electricity market plans with their distributors and postcodes, daily supply, usage rates and time-of-use windows, controlled load, solar feed-in, and any conditions (direct debit, pay on time, membership). About 100 retailers; done in the background, not while someone waits.
2. **Compare plans button on the bill card**: takes the site's postcode and the bill's network, finds the plans sold there, and runs each through the savings estimate for the home as it is now and with the quoted system (solar, battery, night charging). Shows the cheapest 5 with the yearly bill, the feed-in, any conditions and the date the data was fetched.
3. **Use this plan** puts a chosen plan into "Compare with another plan" so the proposal shows the customer's savings on their current plan and on that one.
4. **Guard rails**: never says "switch"; the proposal says these are published plans compared on their use, prices change, check eligibility and conditional discounts, and that Thomson Energy earns nothing from any retailer. Staff pick what goes on the proposal; nothing is sent without a person choosing it. Starts read-only on production, as with every new agent.
5. **Later, if wanted**: a short AI-written "why this plan" sentence for the proposal from the figures (never the figures themselves).

Risks: the AER feed's shape and size need checking from a Netlify function first (it is blocked from Claude's cloud sandbox); plans with demand charges or wholesale pass-through (Amber) are estimated less precisely and are labelled so. Migration: one table plus a sync log. Best model: Fable 5.1 or Opus 5.5 at effort high.

## 35. Wholesale plan estimates (backlogged 23 Oct 2026, to do later)

Owner chose option C from item 34, to build later. Until then the app says "We don't do estimates for wholesale rates" (item 34).

**What it would do:** estimate a year's bill on a wholesale-price plan (Amber, Localvolts, Flow Power, Powerclub) for the home as it is and with the quoted system, so these plans can sit in the plan options table beside the fixed-rate plans.

1. **Past prices:** AEMO's half-hourly (5 minute averaged) regional prices for NSW1 and QLD1, public monthly downloads, kept for the last 2 or 3 years in a table (about 17,500 rows a region a year), topped up monthly by a scheduled function.
2. **Network tariffs:** each network's published network tariff (Essential Energy, Ausgrid, Endeavour Energy, Energex, Ergon Energy): daily charge and time-of-use network rates, a small table updated every 1 July.
3. **Retailer fees:** each wholesale retailer's published fees (monthly or daily membership fee, any margin per kWh, how export is paid) from their CDR plan, kept with the plan.
4. **Model:** price per hour = wholesale price + network rate + fees + GST, run through the same hour-by-hour model in `public/js/solar-roi.js` (load shape from the bill, solar, battery), once for each past year, shown as a range (best year to worst year), never one number.
5. **Battery:** the battery's gain from price spikes (selling into the evening peak) is the hardest part to estimate honestly: assume it only discharges into spikes it could see coming from a simple rule (for example the highest-priced hours each evening), not perfect foresight, and say so.
6. **Wording:** a range labelled as an estimate from past prices, with the same disclaimer as the other plans plus "wholesale prices change every 5 minutes; past prices do not promise future ones".

Size: a bigger build (two tables, a monthly download, model changes, proposal wording). Do it only if wholesale plans come up in enough battery sales. Best model: Fable 5.1, effort xhigh (money shown to customers, new data source, model change).

## 36. Software factory (built 27 Oct 2026, on `staging`, no migration)

Owner's ask: one way for every chat to build so code is easy to add to, easy for a person to step in, with no dead code, no half-working features and no slow pages. Steps: isolate (`/new-feature`, own worktree), build (`/code-structure`), prove (`/prove`: check, dead code, page weight, Playwright smoke run with screenshots, agent evals, fresh review), ship (`/ship`: PR with before and after screenshots), weekly cleanup. What was built, and the one owner step (network access for the smoke run): `docs/SOFTWARE_FACTORY.md`.

Touches: `CLAUDE.md`, `.claude/skills/` (new), `scripts/deadcode.js`, `scripts/page-budgets.json`, `scripts/smoke.js` (new), `scripts/check.js`, `.github/pull_request_template.md` (new), `agents/prompts/`, `agents/evals/` (new). Size: medium. Best model: Fable 5.1, effort high (sets the rules every later build follows).

## 37. One brain, many workers (planned 27 Oct 2026, waiting on the owner's yes)

Owner's asks (27 Oct 2026): agents that see the whole app, report to one ops manager that routes work (no workflow per agent), job tasks ticked when the awaited email arrives, Postie learning from edited drafts and filing emails properly, emails tagged to jobs, bills and the person who must act, a personal planner page (My Plan) for sales and above, an automation spotter, and enquiries turned into draft quotes for sales to approve. Plan, answers and build order: `docs/AI_AGENTS_PLAN.md` "Proposed 27 Oct 2026".

Touches (whole item, built in phases): `netlify/functions/_shared/email-agent.js`, `_shared/sparky-tools.js`, `_shared/chat-ai.js`, `ai-chat-background.js`, `mailbox-work-background.js`, `learn-writing-style.js`, `ops-digest.js`, `_shared/ops-actions.js`, `public/settings.html`, `public/inbox.html`, new `public/my-plan.html`, new migrations (`agent_events`, routes, table registry, job task waiting-on, draft and sent pairs). Size: large, in phases. Best model: Fable 5.1, effort xhigh for phase 1 (new agents, production email data).

## 38. Support links on the Team page (idea 28 Oct 2026, waiting on the owner's yes)

Owner's ask: a Support section on `public/team.html` for anyone struggling, with links and phone numbers to TIACS (This Is A Conversation Starter, free mental health support for tradies, 0488 846 988) and other services (Lifeline 13 11 14, Beyond Blue 1300 22 4636, MATES in Construction 1300 642 111, 13YARN 13 92 76, and 000 in an emergency). Tap to call or open. Visible to every signed-in user, no admin gate. Admin can edit the list (a `company_settings` entry or a small `support_links` table), with a plain line that the links are confidential and outside the app, nothing is logged. Check each number before shipping.

Touches: `public/team.html`, `public/settings.html` (admin edit), one migration if a table is used. Overlaps: none. Kind: feature (into `staging`); migration maybe; money, stock, RLS or payroll: RLS yes if a table. Size: small. Test on staging: any staff login, Team, scroll to Support, tap a number. Best model: Sonnet 5.5, effort medium, because it is a small well-specified page addition.

## 39. Pending leads tab on the Quotes page and lead notifications (LIVE 3 Nov 2026, migration 20261127000000, see PROJECT_SPEC.md A28)

Owner's ask: a tab to the left of Active on `quotes.html` listing the pending leads, so a lead that has not become a quote yet is never lost.

- **Leads (n)** is the first tab, pricing roles only (the `leads` table is readable by pricing roles; other roles see the tabs as today). Pending = `leads.status = 'new'` with a phone or email, and no project linked to it (`projects.lead_id`). Newest first, up to 200.
- Each row: name (or AI title), suburb, source, "needs site visit" badge, age ("3 days", amber past 48 hours, red past 7 days). Tapping a row opens `leads.html?id=<lead>` (the existing deep link opens the lead with Create quote, Create job and site visit).
- The tab label carries the count; an amber dot on the tab when any lead is past 48 hours. Active stays the default tab.
- Website callback requests (`callback_requests` not completed) listed under the leads in the same tab, same amber rule, tap opens the Leads page.
- **Notified of every lead (owner, 30 Oct 2026):** today nothing fires when a website lead or call request lands (the forms insert straight into `leads` and `callback_requests`, no trigger). Add an after-insert trigger on each table that calls `create_notification` (kind `lead`, bell channel by default, pushed to the phone by the existing push sweep) for every active admin, finance and sales user: "New lead: Jane Smith, Penrith (website)" linking to `leads.html?id=<lead>`; "Call request: Jane Smith, Thu 2pm" linking to the Leads page. New tick box `lead` ("New website leads and call requests", pricing) in `NOTIF_GROUPS` so anyone can turn it off.
- **Nothing gets lost:** a 7am Sydney scheduled function `remind-leads.js` re-notifies the same people once a day for each lead still new after 48 hours and each call request still pending past its requested time, one row per lead per day, same `lead` kind.

Touches: `public/quotes.html`, `public/js/notifications.js` (bump `?v=` where it is loaded, `supabase-client.js` `renderMainNav`), `netlify/functions/remind-leads.js` (new), `netlify.toml` (schedule), one migration (two triggers, `set search_path = public`). Overlaps: none. Kind: feature (into `staging`); migration yes (triggers only, no table changes); money, stock, RLS or payroll: no. Size: small. Test on staging: a pricing login, Quotes, the Leads tab is first with the count, tap a lead and it opens on the Leads page; submit the staging website lead form and the bell and phone get "New lead" within a minute; a staff login sees no Leads tab and no lead notifications. Best model: Opus 5.5, effort high, because it now carries a migration with triggers and a scheduled function beside the page work.

## 40. Delete and Already paid buttons on the Emailed bills page (LIVE 4 Nov 2026, migration 20261128030919)

Owner's ask: a Delete button on `supplier-bills.html` for duplicate bills and emails that are not bills, so they stop cluttering the list.

- **Delete** on every emailed bill that is not saved (To check, Could not be read, Duplicate, Not a bill), with a confirm tap. A saved one has no Delete: its bill already sits on the supplier's page.
- The row stays in `supplier_bill_inbox` with status `deleted` (the intake searches the invoice@ label for the last 30 days and would pull the email back in if the row were removed). The stored file is removed from `project-documents` and `file_path` cleared.
- The page hides deleted rows, under All too; the ops digest, Sparky and the ops manager already filter by status so they never see them.
- New `delete` action in `netlify/functions/supplier-bill-inbox.js` (pricing roles, same as the other buttons).
- **Already paid** (owner, same day): a bill that was paid before the email came (card at the counter, paid up front). On a To check bill with the supplier picked it sits next to Save bill; on a Saved bill whose bill is not paid yet it replaces the wait for Pay bills due. Admin and Finance only, like Record as paid. Asks the bill total (as Save bill does), the date paid (today prefilled) and a reference (card, Airwallex, optional). The server saves the bill against the picked PO (or none) exactly as Save bill does, approves it (approved_by, approved_at, pay_on) and records it paid in one database step, `supplier_bills_approve_and_mark_paid` (which calls `supplier_bills_mark_paid`: one `supplier_payments` row, paid_at, paid_by, reference, activity log), so it never appears in Pay bills due. Bill checks still runs on it: a line charged more than the PO still shows red on the PO. New `save_paid` action in `supplier-bill-inbox.js`.

Touches: `public/supplier-bills.html`, `netlify/functions/supplier-bill-inbox.js`, one migration (`deleted` added to `supplier_bill_inbox_status_check`). Overlaps: none (`feat/simpler-purchase-orders` only bumps a `?v=` on the page and is stale). Kind: feature (into `staging`); migration yes (one check constraint); money yes (records a bill as paid), stock, RLS or payroll: no. Size: small. Test on staging: finance@staging.test, Purchases, Emailed bills, Put aside, Delete on one, confirm, it is gone and All does not list it; a Saved one shows no Delete. Then To check, pick a supplier and PO on one, Already paid, confirm the total, today, reference `card`: it moves to Saved, the supplier page shows the bill Paid with that date and reference, and Suppliers, Pay bills due does not list it. Best model: Fable 5.1, effort xhigh, because it records money paid and carries a migration and code in one go.

## 41. Labour by the hour per person on no-quote invoices (planned 2 Nov 2026, yes 3 Nov 2026, built the same day as a fix straight into `main`)

Built as planned below, with the toggle, the itemised shifts and the Less line. Same day, second fix: materials itemised the same way (each PO line or Stock draw, Itemised or Bulk toggle) and a Bill tick on every shift and material row (unticked rows are marked not billable on the job and stay off the next invoice). Not built: "leave it off this invoice only" (untick marks it not billable; tick it again next time to bill it). Spec: `docs/PROJECT_SPEC.md` A22. Follow-up idea: the band rules (standard hours, multipliers, minimum) are constants in `_shared/labour-bands.js`; a Settings screen for them would be the next step if they ever change.

Owner's report: on a job with no quote (Direct Job), labour cannot be added properly; the invoice panel shows one labour sell amount, not hours at a rate per person.

Cause: the "Invoice actual costs" panel on `project.html` works labour out as one dollar figure per cost centre (hours clocked times each person's rate tier sell rate, less what is already invoiced) and shows it as a single Labour box. Nobody sees who, how many hours or the rate, labour that was not clocked can only be typed as a dollar total, and the invoice prints one "Labour" line.

Plan:
1. `get-invoiceable-actuals.js` also returns, per cost centre, one labour row per person: name, rate tier, hours clocked less hours already invoiced for them on this job, and the tier's rate per hour; plus the list of rate tiers.
2. The panel's Labour box becomes a table: person and tier, Hours (editable), $/hr (editable, defaults to the tier rate), Total, Remove. "+ Add labour" adds a row by rate tier (or a person) with typed hours, for travel or someone who did not clock on. The Materials box stays as it is.
3. Each labour row is saved as an invoice line (`invoice_line_items` kind `labour`: hours as quantity, $/hr as unit price, person and tier recorded). The invoice prints one line per person ("Name (Electrician)  3.50  $110.00  $385.00") with no change to `invoice.html` or the token function (items already print as quantity times unit price). Pricing and checks run on the server in `invoice-items.js` and `create-invoice.js`; a typed rate wins, as typing over a Stock price does today. The next invoice on the job only offers hours not yet billed.
4. Migration: `invoice_line_items` gets nullable `staff_id`, `rate_tier_id` and `time_entry_id` (all indexed) and the kind check allows `labour`. No RLS or money function changes. Xero unchanged: labour lines still go to the Labour account.
5. Owner asked 3 Nov 2026 whether it follows the Schedule of Rates. The $/hr comes from the same Billable Rates the schedule prints; proposed addition (waiting on yes, or "flat" for base rates only): each clocked shift is split into standard and penalty parts by the schedule's bands (weekdays 6:30am to 4pm 1x, outside 1.5x, Saturday 1.5x, Sunday 2x, public holiday 2.5x from `public_holidays`), giving a person up to two rows ("Name (Tier)" and "Name (Tier) after hours" at the multiplied rate), and any person's day under 2 hours rounds up to 2. The 3 hour emergency callout minimum stays a hand edit. **Owner, 3 Nov 2026:** a toggle on the panel, "As per Schedule of Rates" (multipliers and the 2 hour minimum, the default) or "Flat" (base rates, hours as clocked); switching rebuilds the labour rows from the clocked time, so hand edits are redone after switching. The server returns each person's hours per band and the browser builds the rows either way. **Owner, 3 Nov 2026, itemised like a lawyer's bill:** in Schedule of Rates mode every clocked shift is its own row (date, start and finish time, person and tier, hours, $/hr, total; a shift crossing a band becomes two rows, a day under 2 hours shows "min. 2 hrs"), each editable or removable, and under the rows a "Less" line (a dollar amount or a percent off the labour, with a short reason such as "goodwill") that prints on the invoice as a negative labour line. Flat mode stays one row per person. Each labour line records its time entry (`invoice_line_items.time_entry_id`) so the next invoice offers only shifts not yet billed.
6. Not in scope: the warranty close-out panel keeps its single labour box; a hand-added labour line does not create a time entry. On a Direct Job already part-invoiced the old way, the first new invoice offers the full hours (the old invoices have no per-person lines), so check that one by eye.

Touches: `public/project.html`, `netlify/functions/get-invoiceable-actuals.js`, `netlify/functions/_shared/invoice-items.js`, `netlify/functions/create-invoice.js`, one migration. Overlaps: none. Kind: feature into `staging`; migration yes; money yes (invoices), stock no, RLS no, payroll no. Size: medium.

## 42. Time tab on the job: see every shift and move wrong ones to another job (LIVE 3 Nov 2026, PR 253, see PROJECT_SPEC.md A13d)

Owner's ask: somewhere in the job to see the times allocated to it and change them to a different job if they are wrong. Today the list exists but is hidden behind clicking the cost figure on the Summary tab, and Edit can only change the stage or category, never the job.

- **Time tab** on every job (new `public/js/job-time.js`, loaded by `project.html` like `job-schedule.js`; no new inline code in `project.html`): every shift on the job, newest first, grouped by day: person, start to finish (Sydney time), break, paid hours, stage, ServiceM8 badge, a "billed on SI-xxxx" badge when an invoice line holds it. Totals per person at the top. Everyone with the job open sees hours; cost per row only for Admin and Finance (as now). The Summary cost figure opens this tab instead of the old pop-up, and the pop-up's code is deleted.
- **Move to another job** (Admin): on each row, pick the right job (search by J number, client or name), then its stage(s) or a non-job category (office, training), Save. Several rows can be ticked and moved together. Hours, dates and pay never change, so Xero payroll is untouched; only which job carries the cost.
- **Server checks** in `admin-update-time-entry.js`: the stages sent must belong to the target job; a shift already billed on an invoice line (`invoice_line_items.time_entry_ids`) cannot be moved off its job (credit or edit the invoice first); a shift still clocked in cannot be moved. Each move writes a line to the job's activity log on both jobs ("Moved Sam's 6.5h on 3 Nov from J7006 to J7010").
- No migration.

Done means:
1. Admin login, open a job with time, Time tab lists each shift with start, finish and hours.
2. Tick a shift, Move, pick another job and stage, Save: it disappears here and shows on the other job's Time tab, and both activity logs say so.
3. A shift billed on an invoice shows the SI badge and Move says why it cannot.
4. Staff login: Time tab shows hours but no cost and no Move.

Touches: `public/project.html` (load the script, add the tab, point the cost figure at it, delete the old pop-up), `public/js/job-time.js` (new), `netlify/functions/admin-update-time-entry.js`, `scripts/page-budgets.json` only if needed (never raised for `project.html`). Overlaps: PR 216 changed `admin-update-time-entry.js` and the old pop-up; it is merged into `staging`, so build on `staging`. Kind: feature (into `staging`); migration no; money, stock, RLS or payroll: job costing and invoices yes (server checks above), payroll no. Size: medium. Test on staging: admin@staging.test, open J9002, Time tab, move the fake ServiceM8 shift to another job and back. Best model: Opus 5.5, effort high, because it is a feature with a known design that touches invoiced labour checks.

## 43. Fixed-price variation labour priced from the Schedule of Rates (LIVE 4 Nov 2026, straight into `main` on the owner's word, see PROJECT_SPEC.md "Variations")

Owner's ask (4 Nov 2026): a fixed-price variation's labour line is just a dollar figure typed in. It should pick labour from the Schedule of Rates like every quote stage does.

- **Labour line = tier + hours.** In the fixed-price variation editor a Labour line shows the rate tier dropdown (`billable_rate_tiers`, "Licensed Electrician ($120/hr)") and an Hours box; the amount is hours x the tier's sell rate and the description defaults to the tier name, the same as a quote stage line. A Materials line is description, quantity and unit cost (the cost price, as a quote stage line), and one Markup % box on the variation (default from Settings > Company default markup) marks every materials line up to its sell amount; the client only ever sees the sell amount. (Owner, 4 Nov 2026: cost plus markup, same as everywhere else.) "+ From Stock or prebuild" keeps working: Stock comes in as a materials line at its cost price and quantity (marked up by the box, not pre-multiplied); a prebuild's components come in one line each (its labour at the prebuild's own rate, its materials at cost), grouped under the prebuild so the client's document shows it as one line with the prebuild's client description (owner asked 4 Nov 2026: yes, prebuilds show as the prebuild name).
- **Saved on `fixed_lines`** (jsonb, no migration) as `{ description, item_type, amount, quantity, unit_cost, rate_tier_id, markup_percent }` (labour: quantity = hours, unit cost = the tier's sell rate; materials: quantity x cost x (1 + markup)); `create-variation.js` works every amount out again on the server from the tier's current sell rate and the markup sent, so the browser cannot send a different figure.
- **Client document** (`quote.html?variation=`): a labour line prints "Licensed Electrician, 4 hrs at $120.00" with its amount; the total is unchanged.
- **On approval** (`_shared/approve-variation.js`): the stage's labour line items get quantity = hours, unit cost = rate and `rate_tier_id`, and materials line items get quantity and unit cost at the cost price with the stage's `markup_percent` set to the variation's markup (today the stage is made at markup 0 with sell amounts), so the job's Edit stages and costing read like any quoted stage. The stage's quoted amount is still the total the client signed.
- The editor moves out of `project.html` into `public/js/variation-fixed-editor.js` (the `/code-structure` rule: no new inline code on `project.html`).

Done means:
1. sales@staging.test, open a job, Variations tab, New fixed-price variation: a Labour line shows the tier dropdown and Hours, picking "Licensed Electrician" and 4 hours shows $480.00; a Materials line of 10 at $20 with markup 45% shows $290.00.
2. Save draft, the card lists the line with its amount; Make PDF, the document says "Licensed Electrician, 4 hrs at $120.00".
3. Mark it approved by phone: the job gets the variation stage with a labour line of 4 hours at $120 and a materials line of 10 at $20 with markup 45% under Edit stages, quoted amount $770.00.
4. "+ From Stock or prebuild" with a prebuild still adds its labour and materials lines.

Touches: `public/project.html` (delete the inline editor, load the new script), `public/js/variation-fixed-editor.js` (new), `public/quote.html`, `netlify/functions/create-variation.js`, `netlify/functions/_shared/approve-variation.js`. Overlaps: none. Kind: feature (into `staging`); migration no; money yes (variation price the client signs, server recomputes it), stock no, RLS no, payroll no. Size: medium. Test on staging: sales@staging.test, the four clicks above. Best model: Fable 5.1, effort high, because it changes a price the client signs and the stage the job is billed from.

## 44. Scan a part into Stock: photo of the part number or barcode, priced per supplier by price lists and bills (planned, yes, built and LIVE 4 Nov 2026, PR 263 and 265, see PROJECT_SPEC.md A12 and A11b)

Built 4 Nov 2026 in `feat/stock-scan`, migration 20261128050000. The Used stock panel moved out of `supabase-client.js` into `js/used-stock.js` (loaded on demand) so every page got about 13 KB lighter.

Left for later (from the cleanup pass, 4 Nov 2026): the 20% price rule as a Settings number (`company_settings`, read by `material_supplier_price_set`) instead of a number in SQL; one SQL item key function (`_item_key`) with `supplier_price_items.item_key` generated from it so the reader's JS key and the link key cannot drift; the emailed one-tap and auto saves calling `supplier_bill_save_review` as the service role so there is one bill save; `price_change_apply / skip / undo` as SQL steps instead of the three JS functions in `price-list-intake.js`; one `_shared/claude.js` for every Claude call (`callClaude` in `price-list-ai.js` is the start); stock categories as a settings list used by the Stock form and the label reader.

Owner's ask (4 Nov 2026): the guys take a picture of an item's part number or barcode and it comes into Stock with no price. When a price list or a supplier invoice later arrives with that part on it, the price lands on our Stock item by itself.

What exists already: "Not in Stock? + Add it" at clock-out makes a $0 item flagged **Needs a price** and `materials_price_fill` pushes the first price into the stock pull lines and job costs (spec A12). Price lists keep every supplier part in `supplier_price_items` with a part number and link to our materials through `material_supplier_links` (spec A11b). Bills are read by Tally from a photo or PDF, lines are description only (no part number). Nothing reads barcodes yet.

- **Scan a part** (new `public/js/stock-scan.js`, one panel used from three places): the Stock page (**+ Scan a part**), each vehicle page (**Scan a part into this van**) and the clock-out / Used stock panel next to "Not in Stock? + Add it" (**or take a photo**). The camera opens, the photo goes through `compressImage()`, and the phone's own barcode reader (`BarcodeDetector`, free and instant on Android Chrome) is tried first; the photo then goes to the new function `read-part-label` (`requireActiveUser`, Claude vision through the same key as Tally) which returns the barcode digits printed under the bars, the part number / product code, brand, a short plain name, and pack size. Works for a label photographed on a box, a bag or the item itself.
- **Check before save:** the panel shows what was read (name, part number, barcode, brand, all editable), how many, and where (Warehouse or this van, prefilled from where the person is). If the barcode or part number already matches a Stock item it says "This is Clipsal 56C320, already in Stock" and adds the count to that item instead of making a second one. Save runs one locked server step `material_add_from_scan` (anyone logged in): makes the item at $0 with `needs_price`, part number, barcode, brand and the photo (saved to `project-documents/stock/`), sets the count at that place through the logged count path, and logs "Added by scan: 10 at the Warehouse" on the item. The existing Needs a price list on the Stock page picks it up; nothing new for Admin to learn.
- **One price per supplier** (owner, 4 Nov 2026: several suppliers sell the same item; a bill or list sets that supplier's price only, and the other suppliers' prices sit beside it so we can ask them to match). `material_supplier_links` already holds one row per material and supplier (part number, confirmed link); it gains `last_cost`, `last_cost_at`, `last_cost_source` (`price_list` or `bill`) and `last_bill_id`. `materials.cost_price` (what quotes and stock use) follows the item's **Buy from** supplier (`materials.supplier_id`, set today in the edit panel); an item with no Buy from takes the first supplier that prices it. Every supplier price goes through one locked server function `material_supplier_price_set(material, supplier, cost, source, import or bill)`: upserts the link's price, and when that supplier is the Buy from one, moves `materials.cost_price` (the `materials_price_fill` trigger then fills any $0 stock pull lines and job costs) and writes a `price_changes` row (new `source` and `bill_id` columns) so it shows under Changes made with Undo.
- **Price lists price it by part number** (`_shared/price-list-intake.js`): before the fuzzy "Is our X their Y?" suggestions, any material whose part number equals a supplier price item's part number (normalised: case, spaces and dashes ignored) is linked by itself, no person needed, with a `price_changes` row kind `match` status `applied`. The price lands on that supplier's link; the Buy from supplier's price moves `materials.cost_price` under the rule as now (under 20% applied, 20% or more waits; a $0 item is priced straight away).
- **Bills update prices** (owner, 4 Nov 2026: so our pricing is current). Tally reads a `part_number` per bill line (`supplier_bill_line_items.part_number`). On every bill save (one-tap, auto-save, reviewed) each line linked to a material (by PO line, part number or barcode) sets that supplier's price from the line (ex GST), applied straight away because it is what we actually paid, logged with Undo. The Buy from supplier's bill moves `materials.cost_price`; another supplier's bill only updates their price beside it. (Replaces the A11a rule that bills leave material prices alone.)
- **Other suppliers' prices, ask to match:** the Stock edit panel lists every supplier linked to the item with part number, last price, date and where it came from (bill or list), cheapest marked, **Buy from this one** (switches `materials.supplier_id` and the cost price, logged) and **Ask to match** (drafts an email to that supplier through the existing supplier email path: "Supplier B sells part 56C320 to us at $11.90, can you match?", a person edits and sends). The PO Create panel shows the Buy from supplier's price as now.
- **Stock page:** Part number and Barcode fields in the edit panel (pricing roles), the photo as a thumbnail, and search also matches part number and barcode. `materials.part_number`, `barcode`, `brand`, `photo_path`, an index on each; `supplier_bill_line_items.part_number`; `material_supplier_links.last_cost`, `last_cost_at`, `last_cost_source`, `last_bill_id`; `price_changes.source`, `bill_id`.

Done means:
1. staff@staging.test on a phone, Stock page, + Scan a part, photograph a box label: the panel shows the name, part number and barcode read off it; Save: the item is on the Stock page with a red Needs a price chip and the count at the Warehouse.
2. Scan the same label again: "already in Stock", Save adds the count to the same item (no duplicate).
3. finance@staging.test, Price lists page, upload a list (or email one to the staging inbox) with that part number: the item is priced, Changes made lists "Linked by part number", the chip is gone, Undo puts it back to $0.
4. Supplier page, upload a bill photo from Haymans with that part number at $12.40: Haymans' price on the item is $12.40 and, Haymans being the Buy from supplier, the item's cost price is $12.40 with a Changes made row and Undo. A bill from L&H for the same part at $11.90: L&H $11.90 sits beside Haymans on the item, the cost price stays $12.40, Ask to match drafts the email to Haymans, Buy from this one switches the cost price to $11.90.
5. Vehicle page, Scan a part into this van: the count lands on the van, not the Warehouse.

Touches: `public/js/stock-scan.js` (new), `public/stock.html`, `public/vehicle-stock.html`, `public/js/supabase-client.js` (one button in the Used stock panel), `netlify/functions/read-part-label.js` (new), `netlify/functions/_shared/supplier-invoice-ai.js`, `netlify/functions/_shared/supplier-bill-intake.js`, `netlify/functions/_shared/price-list-intake.js`, `netlify/functions/extract-supplier-invoice.js`, `public/price-lists.html` (Changes made shows bill prices too), `netlify/functions/supplier-checks.js` or a small new function for Ask to match, one migration (columns, `material_add_from_scan`, `material_supplier_price_set`, part number matching and price setting in `supplier_bill_save_review`). Overlaps: PR 247 (item 40) touches `bill-check.js`, `supplier-bill-inbox.js` and `supplier-bills.html`, none of these files, so none. Kind: feature (into `staging`); migration yes; money yes (cost prices set from lists and bills), stock yes (counts added by scan), RLS no, payroll no: backup before the production migration. Size: large (a day to a day and a half). Test on staging: staff@staging.test and finance@staging.test, the five clicks above; needs the Anthropic key on staging for the label reading and Tally. Best model: Fable 5.1, effort xhigh, because it sets stock counts and cost prices in one build with a migration.

## 45. ServiceM8 claims count in the job's claimed percentage (bug, LIVE 4 Nov 2026, migration 20261128060000, see PROJECT_SPEC.md A27)

Owner (4 Nov 2026): J7002 has two ServiceM8 partial invoices (4515A and 4515B, about 30% of the job). A new claim should be claim 3 and the panel should only let 0 to 70% be claimed.

Cause: the ServiceM8 import puts the Completed claims into `cost_centres.invoiced_amount` and the job's notes, nothing else. Every "claimed to date" view reads invoice rows instead: the stage claims card ("No claims raised yet", $0 of $78,417.35), the Invoice project panel (offers 100%), the invoice's own Claim summary (`get_invoice_by_token_v3` claimed_before) and the "Progress claim N" counter in `create-invoice.js` (would say claim 1). Only the server's cap reads `invoiced_amount`, so it refuses more than what is left but the page never showed why. The panel's "Claim this % of the total contract value" is also really a % of what is left. Seven live jobs are affected: J7002, J7009, J7018, J7043, J7047, J7048, J7049 (one or two ServiceM8 claims each, listed in each job's notes).

- **Imported claims stored as data:** `cost_centres.imported_claims jsonb` (`[{ number: "4515A", amount: 7841.73, source: "servicem8", date: "2026-07-10" }]`). Migration fills it for the seven jobs from the notes block, and the ServiceM8 import writes it from now on (`sm8-import-jobs.js`, the review screen passes the Completed claims).
- **Claims card:** imported claims listed first ("4515A, ServiceM8" badge, no View or Push to Xero), counted in Claimed to date and Remaining.
- **Invoice project panel:** "Claimed so far: $25,641.73 (32.7%)". "Claim this % of the contract value" is now of the contract value, limited to what is left (67.3% on J7002, the default), and the preview says "This claim $X, taking the job to Y% claimed". Choose per stage is unchanged (it already works off Remaining).
- **Claim number:** `create-invoice.js` counts imported claims, so J7002's next invoice is "Progress claim 3".
- **Invoice page:** `get_invoice_by_token_v3` adds the stage's imported claims to claimed_before, so the Claim summary on the client's invoice reads 32.7% before this claim, and lists them under Previous invoices on this job.

Done means:
1. J7002 Summary tab, the stage's claims card lists 4515A $7,841.73 and 4515B $17,800.00 as ServiceM8 claims, Claimed to date $25,641.73 of $78,417.35, Remaining $52,775.62.
2. Invoice project: shows claimed so far 32.7%, the % box will not go above 67.3, 10% previews $7,841.74 taking the job to 42.7%.
3. Create the invoice: it is "Progress claim 3"; its invoice page Claim summary says claimed to date 42.7% and lists 4515A and 4515B under previous invoices.
4. A fresh ServiceM8 import of a job with a Completed claim shows that claim on the card straight away.

Touches: `public/project.html` (claims card, Invoice project panel), `netlify/functions/create-invoice.js`, `netlify/functions/sm8-import-jobs.js`, `public/sm8-import.html`, one migration (`imported_claims` column, data fix for the seven jobs, `get_invoice_by_token_v3`), `public/invoice.html` only if the previous-invoices list needs the badge. Overlaps: none (`feat/stock-scan` is on other files). Kind: bug fix (straight into `main`); migration yes; money yes (what a claim may be and the figures printed on invoices), stock no, RLS no, payroll no; backup of `cost_centres` and `projects` notes before the production migration. Size: medium. Test on staging: finance@staging.test; I put two fake ServiceM8 claims on a staging job by hand first, then the four clicks above on that job. Best model: Fable 5.1, effort xhigh, because it is a migration plus the claim maths on live invoices (type `/effort xhigh` before yes).

## 46. Charge rates you can pick per client and per job (planned, yes and LIVE 4 Nov 2026, see PROJECT_SPEC.md D1a)

Owner's ask (4 Nov 2026): "make the charge rates selectable so if I want to charge someone at a higher rate I can, or lower." Today every client is charged the one set of Billable Rates (Settings > Billable Rates: rate tiers such as Licensed Electrician $120/hr); the only way to charge more or less is to retype each line. Read as: charge a client (and so a job) at a chosen level, not as per-person rates (each person already has a tier).

- **Charge rate levels** (`rate_cards`: name, percent of the Billable Rates, default flag, order), kept under Settings > Billable Rates as a second list: **Standard 100%** is there from the start and is the default; the owner adds any others, for example Commercial 115%, Builder 110%, Mates rates 85%. Pricing roles edit them (`js/settings-rate-cards.js`, no new inline code on `settings.html`).
- **Picked on the client** (Clients page form, "Charge rates", default Standard) and **on each quote or job** (`projects.rate_card_id`, set from the client when the quote is made by a database trigger, changeable any time on the job page: a chip in the Summary "Charge rates: Commercial (+15%)" with a dropdown for pricing roles, `js/job-rate-card.js`). Changing it on a job does not reprice what is already saved; it changes what is priced from then on.
- **Applied everywhere the Billable Rates are used for that job:** quote stage labour lines (the tier dropdown shows "$138/hr, Commercial" and fills that rate; `project.html` loads `RATE_TIERS` at the job's level), prebuild labour added to a stage, fixed-price variations (`js/variation-fixed-editor.js`, and the server's own recompute in `_shared/variation-lines.js`), Invoice actual costs on no-quote jobs (`get-invoiceable-actuals.js`: every shift's $/hr and the + Add labour tiers at the job's level, then the Schedule of Rates bands on top as now), and the Schedule of Rates the client reads (the quick estimate page through `get_quote_by_token`, and Documents > Schedule of Rates on a job) printed at the job's level with the level named. The public rates page and the Documents page stay at Standard.
- Every amount is still worked out on the server where it already is (variations, invoice lines); the browser only shows the same figure.

Done means:
1. sales@staging.test, Settings > Billable Rates: a Charge rates list with Standard 100% (default); add Commercial 115%.
2. Clients page, open a client, set Charge rates to Commercial, Save; make a new quote for them: the Summary chip says Charge rates: Commercial (+15%), and a stage's labour tier dropdown shows the Licensed Electrician rate at 115% (for example $138.00 instead of $120.00); adding a tier line fills that rate.
3. A Direct Job for that client, a clocked shift, Invoice actual costs: the shift's $/hr is the 115% figure (and the after-hours band is 1.5x of that); switch the job's chip to Standard, reopen: back to the base rate.
4. New fixed-price variation on the Commercial job: the tier's rate is the 115% figure; the saved amount matches.
5. The estimate's Schedule of Rates page (quick estimate for that client) prints the 115% rates with "Commercial rates" under the heading.

Touches: `public/settings.html` (loads the new script), `public/js/settings-rate-cards.js` (new), `public/clients.html`, `public/project.html` (two `RATE_TIERS` lines plus loading the chip script), `public/js/job-rate-card.js` (new), `public/js/variation-fixed-editor.js`, `public/quote.html` and `public/js/schedule-of-rates.js` (level named), `netlify/functions/get-invoiceable-actuals.js`, `netlify/functions/_shared/variation-lines.js`, `netlify/functions/generate-client-document-pdf.js` (job Schedule of Rates at the job's level), one migration (`rate_cards`, `clients.rate_card_id`, `projects.rate_card_id`, the default trigger, `get_quote_by_token` and `get_schedule_of_rates` taking the level). Overlaps: none (PR 247 is the Emailed bills page; waiting items 4, 26, 37, 38, 40 touch none of these). Kind: feature (into `staging`); migration yes; money yes (what clients are charged), stock no, RLS yes (one new table, everyone reads, pricing roles write), payroll no. Size: medium (half a day). Test on staging: sales@staging.test, the five clicks above; no keys needed. Best model: Fable 5.1, effort xhigh, because it changes what every client is charged, with a migration.

## 47. Merge a client's jobs into one job with separate cost centres (planned, yes and LIVE 4 Nov 2026, see PROJECT_SPEC.md A13e)

Owner's ask (4 Nov 2026): when a client has more than one job, merge them into one job, each old job becoming its own cost centre (stage) on the one job.

- **Where:** the job page Summary, **Merge another job into this one** (Admin only). It lists the client's other jobs with a J number that are not complete or archived; tick one or more. A confirm screen says what will move from each: its stages, shifts, POs, bills, invoices and claims, variations, tasks, documents and photos, bookings, notes, materials used, STCs, assets, inspections and emails (counts), and that the old J number keeps working.
- **One server step** `project_merge(p_into uuid, p_from uuid[])` (Admin, all or nothing): every table with a job id (about 25, listed in the migration) is re-pointed to the one job; each old job's cost centres come across as they are (their line items, claims, invoice lines, shifts and PO lines follow because they point at the cost centre, so nothing is re-costed and no invoice changes), renamed "J7010: <stage name>" so you can see where they came from; the old job's row stays as a pointer (`projects.merged_into_project_id`, pipeline stage archived, status merged) so its J number, its ServiceM8 id and any link already sent or printed still land on the merged job (the job page and global search follow the pointer and say "J7010 was merged into J7006 on 4 Nov 2026"). Every move is written to the activity log of both jobs and to a `project_merges` row (what moved, with the ids) so a merge can be unwound by hand if ever needed; no Undo button in this first build.
- **Checks on the server:** same client on every job; none of them a quote (Q number only), already merged, or the same job; nobody clocked in on a job being merged; the merged job's claimed amounts, time totals and PO totals are the sum of the parts afterwards (recomputed by the existing triggers).
- **Not merged:** the client's quotes (approve a quote onto the merged job instead: a later step if wanted) and jobs that are complete or archived (they can be merged by reopening first).

Done means:
1. admin@staging.test, a client with two jobs J1 and J2 (each with a stage, a shift, a PO and an invoice): open J1, Summary, Merge another job into this one, tick J2, the confirm screen lists J2's counts, Merge.
2. J1 now shows J2's stage as "J2: <name>" with its line items, the shift under Time, the PO under POs and the invoice under Invoices, totals adding up; the activity log says what moved.
3. Opening J2's old link lands on J1 with the "was merged into" note; global search for J2 finds J1.
4. staff@staging.test on My Day: clock in on J1 and the stage list offers both stages; J2 is gone from the job list.

Touches: `public/project.html` (one button, loads the new script), `public/js/job-merge.js` (new: the picker, counts and confirm), `public/js/supabase-client.js` (job lookup follows the pointer), `public/js/global-search.js`, `public/projects.html` (merged rows hidden or badged), one migration (`projects.merged_into_project_id`, `project_merges`, `project_merge` function, the pointer on the lookups). Overlaps: none today; build after item 46 if both are yes (both touch `project.html`, one chat, one after the other). Kind: feature (into `staging`); migration yes; money yes (invoices, claims and POs change job), stock no (counts untouched), RLS yes (`project_merges` admin read), payroll no: backup before the production migration. Size: medium to large (most of a day, the long part is the table list and the tests). Test on staging: admin@staging.test and staff@staging.test, the four clicks above; the two seed jobs on staging will do. Best model: Fable 5.1, effort xhigh, because it moves invoices, claims and time across jobs in one step with a migration.

## 48. Commercial agreements: a builder's % off the Schedule of Rates (owner's yes 4 Nov 2026, built 5 Nov 2026, see PROJECT_SPEC.md D1a)

Built as planned, with two choices made while building: a level over 100% stays a surcharge folded into the rates (item 46), and do and charge variations on a quoted job keep the agreement inside their stage price like the quote (only Invoice actual costs and hand-added labour items get the separate line). The composer script is downloaded on first use so the Clients page stays near its budget (raised 690 to 700 KB for the new controls).

Owner's ask (4 Nov 2026): give specific builders 10% or so off the Schedule of Rates on do and charge work, adjust it per client, send it to them as an FYI, and word it as a commercial agreement rather than a discount, so it disappears if there is a SOPA claim or legal action, or whenever we decide to stop it. The invoice shows the Schedule of Rates pricing first, then the agreement's percentage off as its own line, with a note.

Builds on item 46 (charge rate levels, live 4 Nov 2026): the levels stay the engine, the wording and the invoice change.

- **Wording:** Settings > Billable Rates list becomes **Commercial agreements** (same `rate_cards` rows: a name and a % off the Schedule of Rates, levels above 100% still allowed and shown as +15%). Standard stays "none". The client field and the job chip say "Commercial agreement: ABC Homes (10% off)". One agreement per builder when the number differs, named after them, so adjusting a builder is one number on the list.
- **Terms text** in `company_settings.commercial_agreement_terms`, editable under the list. **Owner, 4 Nov 2026:** word it so our rates do not look inflated and so we can withdraw it: the reduction is given for efficiency (a builder who uses us a lot, needs no quote per job and less admin than a small or residential client), and it goes if they stop being efficient (making us wait for payment, disputing invoices through SOPA). **Do not name SOPA as a trigger** (NSW SOPA s34 and Qld BIF Act s200 void clauses that deter use of the Act); the same result comes from a conditional reduction that only stands when the invoice is paid in full by the due date. Lawyer to read it once. Default wording (drafted 4 Nov 2026, waiting on yes):
  > **Commercial agreement: efficiency rate.** Thomson Energy Australia charges every client at the rates in our Schedule of Rates (attached). They are our standard rates for all work, large or small. Working with [Client] takes less of our time than most jobs: regular work without a quote for each job, clear site instructions, and less phone, email and paperwork time per job. We pass that saving on. While this agreement is in place, labour on your do and charge work is invoiced at the Schedule of Rates less [10]%, shown as its own line on each invoice. This is a goodwill arrangement between us, not a term of any quote or contract. Our Schedule of Rates remains the agreed rate for all work. It depends on that efficiency continuing. We may end it at any time by written notice, and we will if the time a job takes us changes, for example invoices not paid in full by their due date, work regularly queried after the fact, or more quoting and administration per job. We review it each year. The reduction on any invoice applies only when that invoice is paid in full by its due date. If it is not, the reduction is withdrawn for that invoice and the balance at the full Schedule of Rates is payable. When the agreement ends, the full Schedule of Rates applies to all work from that date. Invoices already paid are not changed. The reduction applies to labour rates only. Materials, equipment, subcontractors, permits and fees are charged as quoted or invoiced.
  Invoice note under the totals: "Labour is charged as per our Schedule of Rates. The commercial agreement line is a conditional reduction under our agreement with you dated [date]. It applies when this invoice is paid in full by the due date and is otherwise withdrawn, with the balance payable." Email body: attached is your commercial agreement and our current Schedule of Rates, the [10]% efficiency reduction on labour for do and charge work and its conditions, nothing to sign.
- **FYI letter:** Clients page, **Send commercial agreement**: a PDF (agreement page with the client's name, the % off, the terms, the date, then the Schedule of Rates at Standard) made by `generate-client-document-pdf` (new type), emailed from sales@ in the sender's name to the client's main contact through `send-recorded-email` (shows in the Inbox), `clients.agreement_sent_at` recorded and a "Sent 4 Nov 2026" line on the client. Resend any time after a change.
- **Withdraw:** Clients page, **Withdraw agreement** with a reason (late payment, disputes, more admin per job, our decision): a database function sets the client and every open job of theirs back to Standard, records `clients.agreement_withdrawn_at` and reason, writes each job's activity log. The next invoice has no agreement line. Invoices already sent are not changed by the app; invoicing the withdrawn reduction on an unpaid one is a hand step the terms allow.
- **Invoices on do and charge work** (Invoice actual costs, do and charge variations, hand-added labour items): labour rows at the full Schedule of Rates $/hr (the level no longer folded into the rate), then one negative line made by `create-invoice` from the job's agreement at the time: "Commercial agreement (ABC Homes): 10% off labour", after any Less line, labour only. A note under the totals (wording above: a conditional reduction that stands when the invoice is paid in full by the due date). Goes to Xero as a negative labour income line (same as the Less line today).
- **Fixed-price quotes and fixed variations** keep the agreed rate inside the price (the client sees a lump sum), the quote PDF adds one line "Priced with your commercial agreement (10% off labour)". The Schedule of Rates the client reads (estimate page, job Company docs PDF) prints Standard rates with the agreement box under them instead of discounted rates.

Done means:
1. sales@staging.test, Settings > Billable Rates > Commercial agreements: add "ABC Homes agreement" 10% off; the terms box shows the default text.
2. Clients page, a client, set Commercial agreement to it, Save, Send commercial agreement: the Inbox shows the sent email with the PDF (agreement page then the Schedule of Rates at Standard), and the client shows "Sent today".
3. A Direct Job for that client with a clocked shift, Invoice actual costs: the shift is at the full $/hr; make the invoice: the invoice shows the labour rows, then "Commercial agreement (ABC Homes): 10% off labour" as a minus line, and the note under the totals.
4. Clients page, Withdraw agreement, reason late payment: the client and the job show Standard, the job's activity log has the line; a second invoice has no agreement line; the first invoice is unchanged.
5. A quote for the client: the labour tier rate is still the 10% off figure and the quote PDF says "Priced with your commercial agreement".

Touches: `public/invoice.html`, `public/clients.html` (two buttons, loads the new script), `public/js/clients-agreement.js` (new), `public/settings.html` (nothing new inline), `public/js/settings-rate-cards.js` (wording, terms box), `public/js/rate-cards.js` (chip wording), `public/js/project-invoice-actuals.js` (full rates, agreement line preview), `public/quote.html` and `public/js/schedule-of-rates.js`, `netlify/functions/create-invoice.js` (the agreement line), `get-invoiceable-actuals.js`, `generate-client-document-pdf.js` (new type), `send-commercial-agreement.js` (new), `_shared/invoice-items.js`, `_shared/variation-lines.js`, `_shared/rate-cards.js`, one migration (`company_settings.commercial_agreement_terms`, `clients.agreement_sent_at`, `agreement_withdrawn_at`, `agreement_withdrawn_reason`, `client_withdraw_agreement()`, `get_quote_by_token` and `get_schedule_of_rates` back to Standard rates plus the agreement fields). Overlaps: item 47 (waiting on yes) touches `project.html`, not these files; no unmerged branches; open PRs could not be read in this chat (GitHub tool down), check before the branch. Kind: feature (into `staging`); migration yes; money yes (what clients are charged), stock no, RLS no new table (one security definer function, pricing roles), payroll no. Size: large (a day). Test on staging: sales@staging.test, the five clicks above; Gmail key on staging for the send. Best model: Fable 5.1, effort xhigh, because it changes how every do and charge invoice is priced, with a migration.

## 49. Purchase orders with less manual work: bills link by themselves, open POs accept their charges, extras on a fixed PO flagged red with tick-and-act (planned 5 Nov 2026, revised the same day, waiting on the owner's yes)

Built first, 5 Nov 2026 (bug fix, PR into `main`): the emailed bill matcher in `supplier-bill-intake.js` links by part number first, then by description at 75% or better, and never to a PO line already billed in full. Auto-accept on open POs (below) relies on it: with the old 50% rule a wrong link would have been accepted with nobody looking.

Owner's ask (5 Nov 2026): "The purchase orders seem to be too much manual work. Make it so the bill links automatically accepting the charge, and we can tick stuff and move to another job or stock or query price with supplier." Then: "If it's a fixed line PO then flag it red as additional or something so we can query supplier or change it job/stock." On production today: 20 emailed bills waiting on the Emailed bills page, 6 saved bills with problems, 28 red bill lines waiting (all "Not on the linked PO": 7 on open POs, $169.62; 13 on closed fixed POs, $3,072.58; 8 on bills with no PO any more, $27,896.80), auto-save off.

- **Bills save themselves when the PO is clear.** Auto-save turns on (`api_keys` `supplier_bill_auto_save` = on) for confident matches only: our PO number on the bill (that supplier's PO), or the supplier's one open PO with the total within $1. A name alone, a "New, check details" supplier or an ABN or bank warning still waits for a person. Never approves for payment, never touches Xero.
- **Open PO: the charges are accepted automatically** (reviewed, one-tap and automatic saves, one database step): a line not on the PO is added to the PO and linked (freight is received to the PO's own job, van or Warehouse so it is costed; other lines wait for Receive); a line charged more takes the billed price on the PO line and the job's cost rows. Each is marked **Accepted automatically** (amber) on the PO with what changed, and the bill check counts it as decided.
- **Fixed PO (lines known when ordered): extras are flagged red, never accepted by themselves.** A bill line not on the PO shows red **Additional, not ordered**; a line charged more than the PO shows red **Charged more: PO $12.40, billed $14.20**; freight shows red **Freight charged**. They stay red (and the bill unapproved) until someone decides.
- **Tick lines and act, on the PO page** (PO lines and red bill lines both have tick boxes; the Receive bar gets more buttons): **Accept onto this PO** (red lines: added and received to the PO's own job, van or Warehouse, or the billed price taken), **Move to another job** (search, then the stage), **Move to Stock** (Warehouse or a van), **Query supplier** (one email listing each ticked line, "not ordered" or "PO $12.40, billed $14.20", the bill stays unapproved until it is sorted; a person edits and presses Send from invoice@) and **Deny charge** (red lines, with a reason). Moves and accepts run as one server step for all the ticked lines (`po_lines_act`, all or nothing, same rules as Move today: comes off where it was, refused if already invoiced or the stock is no longer there). Logged on the PO, the bill and each job.
- **One-off now:** the 7 waiting lines on open POs are accepted the new way (logged). The 13 on closed fixed POs stay red for a decision (now with the tick-and-act buttons). The 8 lines ($27,896.80) on bills whose PO no longer exists are listed for the owner to link to a PO or decide by hand.

Done means:
1. finance@staging.test: a test bill quoting a staging **open** PO saves itself; its extra line shows amber "Accepted automatically, added to PO", nothing red.
2. The same bill against a **fixed** PO: the extra line shows red "Additional, not ordered" and a higher price shows red "Charged more: PO $12.40, billed $14.20"; the bill is not approved.
3. PO page, tick the red extra line, Move to another job, pick the job and stage: it is added and costed there, both jobs' activity logs say so, the line turns green.
4. Tick a red line, Query supplier: the email lists it as not ordered; Send logs it on the PO and the bill.
5. Tick two PO lines, Move to Stock, Warehouse: both counts go up.

Touches: `public/purchase-order.html` (loads the new script), `public/js/po-line-actions.js` (new: the tick bar, move, accept, query and deny panels), `public/js/supabase-client.js` (bill line colours and tick boxes, one place), `netlify/functions/_shared/supplier-bill-intake.js`, `netlify/functions/_shared/bill-check.js`, `netlify/functions/_shared/supplier-email.js`, `netlify/functions/supplier-checks.js`, one migration (`supplier_bill_lines_auto_accept` for open POs, `po_lines_act`, `supplier_bill_save_review` calls the auto-accept, resolution `auto_accepted`), the `api_keys` switch on staging then production. Overlaps: none (PR 34 is the email workers; item 48 is invoices). Kind: feature (into `staging`); migration yes; money yes (bill charges accepted, costs to jobs), stock yes (moves to stock), RLS no, payroll no: backup before the production migration. Size: large (most of a day). Test on staging: finance@staging.test, the five clicks above; a bill uploaded on a supplier page does instead of an emailed one. Best model: Fable 5.1, effort xhigh, because it accepts supplier charges and moves stock and job costs, with a migration.

## 50. A bill line charged $0 is "no charge", not an extra to accept (owner's yes 5 Nov 2026, built the same day, PR into `main`)

Found on PO2000 (J7002, Tradezone). Order M03125 was invoiced twice: M61732 ($3,165.46, on PO2001, six items received to the job at their prices, $2,877.69 of job cost) and M74144 ($186.58, on PO2000, only the 2 back-ordered Dore 350 Amp 13 hole links at $84.81). The M74144 PDF repeats the other six items at $0. They showed red "Not on the linked PO", were accepted onto PO2000 on 5 Nov as $0 lines, and the owner asked why they show no price. The $0 is right: those goods are already on PO2001 at their prices. Putting prices on them would cost the job twice ($2,877.69).

- **One-off data fix (production, owner's yes first):** delete the 6 unreceived $0 lines from PO2000 (no job cost rows, nothing received), mark the 6 bill lines Accepted with a note "No charge, already on M61732 / PO2001", re-check both bills. PO2000 is then 2 x $84.81 = $169.62, equal to the bill ex GST.
- **Rule going forward (built, no migration):** the bill reader takes the quantity **supplied on this invoice** (not the ordered figure: an item shown with 0 supplied is quantity 0). A bill line charging nothing (quantity 0 or $0) shows **No charge** (green) on the PO page, is never flagged red, never needs Accept, and is never added to an open PO (`isNoCharge()` in `bill-check.js` and `supabase-client.js`). The bill's own total check still catches a price the reader missed (lines no longer add up to the bill total). Item 49's auto-accept must skip no-charge lines.
- **Known gap:** a bill uploaded by hand on the supplier page still goes through `supplier_bill_save_review` (SQL), which can add a $0 line to an open PO or flag it; the PO page then shows it as No charge and the bill check ignores it, so nothing turns red. Fix in the SQL when item 49 rewrites that function.
- **Also found, owner to decide:** bill M61732 ($3,165.46, PO2001) is saved twice (two rows, same number, both unpaid and unapproved, both "problems"). Delete one before anything is approved or paid, or it can be paid twice.

Touches: `netlify/functions/_shared/supplier-bill-intake.js`, `netlify/functions/_shared/bill-check.js`, `public/js/supabase-client.js` (`billLineState`), production data for PO2000 and bill M61732. Overlaps item 49 (same files, waiting on yes). Kind: bug fix into `main`; migration no; money yes (PO line cost, a duplicate bill).

## 51. PO from a scanned invoice, paid on the spot, lines movable after close (owner's yes 5 Nov 2026, built the same day, PR into `staging`, see PROJECT_SPEC.md A10)

Built in: `feat/po-from-scan`. Follow-ups to decide: a counter purchase could be received on the spot (the gear is in hand) instead of waiting for Receive; a bill uploaded by hand on the supplier page still flags $0 lines (item 50's known gap).

Owner (5 Nov 2026): paying upfront is normal (card at the counter, a hardware store with no account), so paid must not wait for approval; the PO maker should be able to scan the invoice to fill the PO, say it is paid, and still move lines to stock or another job after the PO is closed or paid.

- **Scan the invoice on every Create PO panel** (job page, Purchase Orders, Stock, vehicle page; any role). Tally reads it (`js/po-scan.js`, loaded on demand, `extract-supplier-invoice`): supplier matched the A11 way or created as "New, check details", lines with quantity supplied, cost and part number, **Lines known now** set. Save makes the PO and saves the bill against it in one step (`supplier_bill_save_review`, `po_mode` new, with the panel's job, stage, vehicle, tools kind, notes and paid fields), lines linked, no red.
- **Paid read off the scan.** The reader returns `paid_status` (paid / unpaid / unknown) and `payment_method` (a PAID stamp, "amount due $0.00", "paid by card", a receipt). Paid: the PO is saved as paid with that method, the bill approved and marked paid with the invoice date and number. Otherwise the person ticks **Paid already** (card, cash, bank transfer) on the panel, or later under More on the PO page. Any role.
- **A bill saved against a paid PO is paid** (reviewed, one tap, emailed, automatic): approved and marked paid with the PO's date, method and reference, "from PO 2015" in the log, never in Pay bills due. `purchase_orders.paid_method`, `paid_on`, `paid_reference`, `paid_by`; `supplier_bills.paid_method`.
- **Paid any time** (supplier page, Bill checks): Admin and Finance can mark any unpaid bill paid, approved or not, with date, method and reference (`supplier_bills_approve_and_mark_paid`).
- **Move after close.** `po_move_line` works on a closed or paid PO for received lines (to another job with stage, the Warehouse or a vehicle), landing straight away; the PO stays closed, the bill untouched; refused as before when the job already invoiced the line or the stock is gone.

Done means:
1. staff@staging.test, job page, Create PO, Scan the invoice with a test receipt marked paid: supplier, lines and Lines known now filled in; Save makes the PO with a "Paid by card" chip and a bill that reads Paid.
2. Same with a receipt not marked paid: no chip; tick Paid already, cash, save; the bill reads Paid, cash.
3. Email a bill for a PO ticked paid: it saves as Paid and is not in Pay bills due.
4. finance@staging.test, supplier page, Paid on an unapproved bill: it reads Paid with the date.
5. On a closed PO, Move a received line to another job: it is costed there, both logs say so, the PO stays closed.

Touches: `public/js/supabase-client.js` (paid tick and chip, scan button hook, line menu), `public/js/po-scan.js` (new), `public/purchase-order.html`, `public/project.html`, `public/purchase-orders.html`, `public/stock.html`, `public/vehicle-stock.html`, `public/supplier-detail.html`, `public/supplier-checks.html`, `netlify/functions/extract-supplier-invoice.js`, `netlify/functions/_shared/supplier-invoice-ai.js`, `netlify/functions/_shared/supplier-bill-intake.js`, `netlify/functions/supplier-bill-inbox.js`, `netlify/functions/run-supplier-payments.js`, `netlify/functions/supplier-checks.js`, one migration, `docs/PROJECT_SPEC.md`. Overlaps item 49 (build 49 after this, same chat). Kind: feature into `staging`; migration yes; money yes.

## 52. Supplier bills and payments pushed to Xero (idea 5 Nov 2026, after item 51)

Owner asked whether bills reach Xero and whether to link payments in the app or in Xero. Today nothing about supplier bills reaches Xero (only client invoices, credit notes, timesheets and pay rates). Push from the app and let Xero confirm: when a bill is approved in TEops, push it as a Xero Bill (supplier contact by ABN, created when missing; date, number, lines coded to the purchases account, GST); when it is marked paid, push the payment against that Bill (bank account for transfers and Airwallex, the card or cash account for counter purchases). The bank feed line then shows a suggested match and Jade taps OK (the Xero API cannot press that final OK). Needs first: the purchases and card account codes in `docs/BUSINESS_FACTS.md` (only sales codes today), a run on the Xero demo company. Same ground as item 1 and the spec's Tier 4.


## 53. Email attachments onto the job, and job photos and documents on every email out (planned 5 Nov 2026, waiting on the owner's yes)

**Owner, 5 Nov 2026:** attachments on emails tagged to a job should be saveable into the job's Site Photos or Documents tab with a label, and anything emailed out from a job should be able to carry the job's documents or photos.

**Today:** received attachments are never stored by the app. `emails.attachments` holds only the name, type and size, and `get-email-attachment.js` pulls the file from Gmail when someone opens it (4 MB cap, Netlify's response limit). Outgoing mail (`send-gmail.js`, Gmail API, up to 10 files and 20 MB) takes files from the `email-attachments` and `project-documents` buckets only, so site photos (public `site-photos` bucket) cannot go out. Only "Email the client" on the Emails tab offers the job's documents; the invoice, variation, quote extension, PO and agreement emails attach their own PDF and nothing else.

**Plan**

1. **Save to job** on every attachment chip of a conversation tagged to a job, on the job's Emails tab and in the Inbox (same chips, `email-view.js`). Tap it: Site Photos (label, becomes the caption) or Documents (folder pick from the job's folders or a new one, default "Emails", and the file name as the label). Pictures default to Site Photos, everything else to Documents. A "Save all" on an email with several attachments saves each with its file name as the label. A saved chip shows "On the job" and opens the photo or document; saving again is allowed but asks.
2. **New function `save-email-attachment.js`** (`requireActiveUser`): checks the caller can see the conversation (`threadForUser`) and the conversation is tagged to that job (`email_job_links`), finds the part in `emails.attachments`, downloads it from Gmail on the server through the thread's own mailbox (no 4 MB cap; 25 MB limit), then copies it: pictures to `site-photos/<job id>/<ts>-<name>` plus a `project_photos` row (caption, `staff_id` the caller); other files to `project-documents/documents/<job id>/<ts>-<name>` plus a `project_documents` row (folder, file name, `uploaded_by` the caller). Pictures over 1 MB are squashed on the way through Supabase's image transform to 1920 px, the same size `compressImage()` makes (no image library on the server). Records `saved_to {kind, id}` on that attachment's entry in `emails.attachments`, so the chip knows. No migration.
3. **Add from job** button in the email composer whenever it is opened for a job (`projectId` set): the Emails tab, invoice, variation, quote extension, PO and commercial agreement emails, and an Inbox reply on a conversation tagged to one job. It opens a picker over the composer: Documents (folders, tick boxes, as the Emails tab lists them today) and Site Photos (thumbnails by day, like the tab, tap to tick; videos left out). A running "3 files, 4.2 MB of 20 MB" line, 10 files and 20 MB enforced before Send, same as the server. The job's quote PDF stays pre-ticked on quote emails as now. The documents list moves out of `project.html` (`jobEmailAttachOptions`) into the new script, so the page gets smaller, not bigger.
4. **`send-gmail.js`** allows the `site-photos` bucket, and only for a path that matches a `project_photos.url` row (so a path cannot be guessed). Photo names on the email are the caption or the date, with the J number.

**Done means**
1. Open a job with a tagged email that has a photo attached, tap Save to job > Site Photos, type "Switchboard before", Save: the photo is on the Site Photos tab with that caption, and the chip says On the job.
2. Same with a PDF > Documents, folder "Emails": it is on the Documents tab in that folder under its name.
3. In the Inbox, the same conversation shows the same Save to job on its attachments, and an untagged conversation does not.
4. Invoices tab > Email the invoice > Add from job: tick two site photos and one document, send: the client's email arrives with the invoice PDF plus those three files, and the sent email on the Emails tab lists all four.
5. Tick 11 files, or files over 20 MB: Send is blocked with a plain message before anything leaves.

Touches: `public/js/email-compose.js` (Add from job button, the picker, limits), `public/js/email-view.js` (Save to job on chips), `public/js/email-job-files.js` (new: documents and photos lists, the picker, save calls; `jobEmailAttachOptions` moves here from `project.html`), `public/project.html` (Emails tab chips call the shared code, inline `jobEmailAttachOptions` deleted, `?v=` bumps), `public/inbox.html` (`?v=` bumps, reply passes the tagged job), `public/js/supabase-client.js` (`emailPurchaseOrder` passes the job, `?v=` bump on every page), `public/js/clients-agreement.js` (`?v=`), `netlify/functions/save-email-attachment.js` (new), `netlify/functions/send-gmail.js` (`site-photos` bucket with the row check), `netlify/functions/_shared/supplier-bill-intake.js` (`downloadAttachment` takes a mailbox). Overlaps: none on `staging`; open PR #34 (email workers, 18 Oct, stale) touches the agent, not these files; nothing in the backlog waiting on yes touches them. Kind: feature (into `staging`); migration no; money no, stock no, RLS no, payroll no. Size: medium (a morning). Test on staging: sales@staging.test (Gmail key on staging for the send and the Gmail download), the five Done means clicks above. Best model: Opus 5.5, effort high, because it is a feature build with a known shape and no migration, money or RLS.
