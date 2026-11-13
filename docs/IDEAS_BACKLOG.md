# TEops Ideas Backlog

Last updated 13 Nov 2026 (items 85 and 86 released and moved to the built file; items 84 and 87 waiting on yes)

Open work only: planned, waiting on yes, partly built, or built with something still to do. Code is the source of truth: if something here is built, move it to `docs/PROJECT_SPEC.md` and its write-up to `docs/archive/IDEAS_BACKLOG_BUILT.md` (same item number) in the PR that ships it, so this file stays short for every chat that reads it.

## Status

| # | Item | Status | High lead time | Depends on |
|---|------|--------|----------------|------------|
| 1 | Payment reconciliation, receipts, tools register | Partly built | N | Airwallex read-only key, accountant sign-off |
| 2 | Voice messages in team chat + Siri Shortcut | Voice messages built with team chat (PROJECT_SPEC A19a), Siri not started | N | Personal tokens for the Siri Shortcut |
| 3 | Native iPhone app (TEgo, Capacitor) | Stage 1 built, waiting on Apple | Y | Apple Developer enrolment approval, then `docs/IOS_APP.md` setup; offline sync design for stage 2 |
| 4 | Weather-aware scheduling worker and Weather page | Not started | N | Job lat/long (not stored today), work type field |
| 6 | Policy sign-off, AI consent, location tracking | Partly built | Y | Adviser review of notice, 14 days' notice, job lat/long |
| 7 | SMS and calls via Twilio | Not started | Y | Native app (3), Telstra port (Twilio bundle approved) |
| 9 | Staff policy set (gaps and fixes) | Planned, waiting on owner's pick | N | Adviser review (Formby or HR), then load into onboarding documents |
| 84 | Supplier bills with fewer taps: confident bills and credit notes save themselves, Accept all on a bill, no total prompt when the reader got it, uploads through the same path as emails, the Stock match default leaves junk out, Sales get the bills-to-match push | Reviewed 13 Nov 2026, waiting on yes | N | Turn `supplier_bill_auto_save` on with it |
| 87 | A bill line that is the same item as a hand-typed PO line takes that line over instead of adding another (PO2020 doubled: the bill's five lines were added beside the five typed ones); the reader pairs by quantity and price when wording and part number do not, a Same as... choice for the rest, PO2020 repaired | Found 13 Nov 2026, planned, waiting on yes | Y (one function, one column) | None |
| 15 | Security sweep and hardening | Planned: last step, once major additions stop | N | Build sequence finished |
| 17 | User-friendliness upgrades (whole-app review) | Owner said build all 168 in six deliveries; deliveries 1 to 4 (items 1 to 109) LIVE 19 to 20 Oct 2026, next delivery 5 (`docs/UX_REVIEW.md`) | N | None |
| 37 | One brain, many workers: see everywhere, event routing, Postie filing and learning, My Plan, enquiry to draft quote (`docs/AI_AGENTS_PLAN.md`) | Step 5 (Postie filing) built 27 Oct 2026, on `staging`; rest waiting on yes | N | Owner's yes to remove the 4 wrong labels on production; staff notice for per-person email |
| 62 | Pipeline moves done by the database: task gate, handover check and all-paid check as triggers, no-quote invoices move to Awaiting Payment, board quote columns for quotes only, 9 jobs put back in the right column | Planned 9 Nov 2026, waiting on yes | N | None |
| 74 | Client portal and lead rewards: builders and repeat clients log in by email code and see their quotes, jobs, status, bookings, who is on site now, shared photos and documents, the Schedule of Rates, invoices, hours on do and charge jobs, request work (a draft quote with a due date, or a do and charge job with suggested dates), and message us on the job; 74b: a client refers a job (or asks for their own quote) from a personal link with no login, it shows in their portal as a quote, and they earn $80, $200 or $500 (paid or credited) when we win it, nothing under $1k, the reward hidden in the quote's cost; a quick referral (no inspection) earns a flat $50; every staff member gets the same form in the app and a link to send anyone, $50 through payroll for a job won from their link, 2% of the saving up to $500 when a job they quoted finishes under budget with a 5 star review (a one-tap review ask at clock-out, QR code or send, credited on the KPIs of whoever got the customer to do it and worth $5 to them, and sent by itself at Complete), every amount and shape in Settings, all of it a sales expense on the Xero P&L, a client document and a staff document explaining it | Owner's yes 11 Nov 2026; PR 1 (login, lists, job page, share ticks, invoices, work so far, usage log) LIVE 12 Nov 2026 (PR 377 straight into `main` on the owner's word, migration 20261201000000, spec A35); PR 2 and 3 to come | N | None (Twilio, item 7, for text messages later) |
| 77 | Whole screen on every page (owner's rule 12 Nov 2026): existing pages move to edge-to-edge columns as they are touched, the job Summary tab first (Tasks far left, summary in the middle) | On `staging` 13 Nov 2026 (PR 431, every staff page), waiting for release | N | Item 76 is the first page |

## Owner to-dos left over from shipped items

Short steps the owner still has to take on things that are already built. Strike a line when it is done. (From the built items now in `docs/archive/IDEAS_BACKLOG_BUILT.md`, 13 Nov 2026.)

- Item 22: Airwallex payouts still to build (needs the payout key).
- Item 24: record the SAA GCBS (battery) accreditation under Team with "battery" in the licence name (item 83's battery fix now reads the class code, so check it is there).
- Item 36: allow `*.netlify.app` on the cloud environment so phone sessions can run the smoke run.
- Item 56: yes to turn auto labels on for the 4 mailboxes.
- Item 57: open Edit on the seven stock items chipped "Looks like cable" and set them to Cable.
- Item 66: check the Interest charged account (270) in Settings > Xero Mapping.
- Item 68: the first real card payment with interest: check the interest invoice lands in Xero.
- Item 70: one Allow tap for the production checklist change (point 9).
- Item 71: Settings > Import from ServiceM8 once, "Deposits to add", tick, Import.
- Item 73: run the picture tagger dry run in Settings (the tagger is off until then); a Photoroom key for the automatic cut-out.
- Item 75: prove the live sun records fetch and Pylon's location call on one draft Solar quote.
- Item 83 part C: purchase account codes for the Xero bill map.

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
- **Ask Sparky too (owner, 13 Nov 2026):** the same Shortcut takes a question ("what is booked at Byron tomorrow"), Sparky answers from the live data, Siri reads it back. Build it as one function, text in and answer out, with the personal token as the login, so TEgo's Siri App Intents (item 3) call the same function later and nothing is built twice.

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
- Home screen widgets, Siri App Intents. **iOS 27.3 (developer preview 3 Nov 2026) opens Siri to apps properly:** an app lists its actions through App Intents, Siri runs them and chains them ("App Skills") without the person naming the app, and can read what is on the app's screen. TEgo would declare Ask Sparky, Send a chat message and Open job, all calling the item 2 function. Needs a small Swift file in `tego-app/` and a TestFlight build; wait for the public release, early reports say support is uneven.
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

## 6. Policy sign-off, AI consent and location tracking

**Law:** NSW Workplace Surveillance Act 2005: written notice at least 14 days before computer or tracking surveillance (employees can agree to less), a computer surveillance policy (s12), tracking only while at work. NSW Surveillance Devices Act 2007: consent for tracking devices.

**Built today:** onboarding makes staff sign the employment contract and `onboarding_documents` policies, with signed PDFs (migration 098, `generate-signed-document`). Versioned re-sign on login, I agree / I don't agree consent forms, consent dates per user and My Profile withdraw (migration 20261018120000, see PROJECT_SPEC A26). Not built: agents honouring the consent (no agents yet; AI start = later of consent date and the notice start date), location capture at clock in/out.

**Source documents (drafts, 18 Oct 2026):** `policies/` has the "Notice of Workplace Surveillance and Computer Surveillance Policy" (required, acknowledge only, also gives notice of future location tracking), "AI Features Consent" (optional) and "Location Tracking Consent" (optional, load only when the iPhone app ships). Adviser (Formby or HR) review before go-live.

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

## 9. Staff policy set (gaps and fixes)

Reviewed 18 Oct 2026 against `policies/`. Have: Code of Conduct, Company Property, Staff Training and Development (all dated 28.10.2024), Surveillance Notice, AI consent, Location consent (drafts), Short Form Employment Contract.

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

## 37. One brain, many workers (planned 27 Oct 2026, waiting on the owner's yes)

Owner's asks (27 Oct 2026): agents that see the whole app, report to one ops manager that routes work (no workflow per agent), job tasks ticked when the awaited email arrives, Postie learning from edited drafts and filing emails properly, emails tagged to jobs, bills and the person who must act, a personal planner page (My Plan) for sales and above, an automation spotter, and enquiries turned into draft quotes for sales to approve. Plan, answers and build order: `docs/AI_AGENTS_PLAN.md` "Proposed 27 Oct 2026".

Touches (whole item, built in phases): `netlify/functions/_shared/email-agent.js`, `_shared/sparky-tools.js`, `_shared/chat-ai.js`, `ai-chat-background.js`, `mailbox-work-background.js`, `learn-writing-style.js`, `ops-digest.js`, `_shared/ops-actions.js`, `public/settings.html`, `public/inbox.html`, new `public/my-plan.html`, new migrations (`agent_events`, routes, table registry, job task waiting-on, draft and sent pairs). Size: large, in phases. Best model: Fable 5.1, effort xhigh for phase 1 (new agents, production email data).

## 38. Support links on the Team page (idea 28 Oct 2026, waiting on the owner's yes)

Owner's ask: a Support section on `public/team.html` for anyone struggling, with links and phone numbers to TIACS (This Is A Conversation Starter, free mental health support for tradies, 0488 846 988) and other services (Lifeline 13 11 14, Beyond Blue 1300 22 4636, MATES in Construction 1300 642 111, 13YARN 13 92 76, and 000 in an emergency). Tap to call or open. Visible to every signed-in user, no admin gate. Admin can edit the list (a `company_settings` entry or a small `support_links` table), with a plain line that the links are confidential and outside the app, nothing is logged. Check each number before shipping.

Touches: `public/team.html`, `public/settings.html` (admin edit), one migration if a table is used. Overlaps: none. Kind: feature (into `staging`); migration maybe; money, stock, RLS or payroll: RLS yes if a table. Size: small. Test on staging: any staff login, Team, scroll to Support, tap a number. Best model: Sonnet 5.5, effort medium, because it is a small well-specified page addition.

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

## 52. Supplier bills and payments pushed to Xero (idea 5 Nov 2026, after item 51)

Owner asked whether bills reach Xero and whether to link payments in the app or in Xero. Today nothing about supplier bills reaches Xero (only client invoices, credit notes, timesheets and pay rates). Push from the app and let Xero confirm: when a bill is approved in TEops, push it as a Xero Bill (supplier contact by ABN, created when missing; date, number, lines coded to the purchases account, GST); when it is marked paid, push the payment against that Bill (bank account for transfers and Airwallex, the card or cash account for counter purchases). The bank feed line then shows a suggested match and Jade taps OK (the Xero API cannot press that final OK). Needs first: the purchases and card account codes in `docs/BUSINESS_FACTS.md` (only sales codes today), a run on the Xero demo company. Same ground as item 1 and the spec's Tier 4.


## 58. Pylon is design only: the pull fills the quote, the layout goes on the proposal, battery STCs worked out from usable kWh (planned 6 Nov 2026, waiting on the owner's yes)

Owner, 6 Nov 2026, after the first real pull (Q for 5 Matilda Road, Gaven, design `Voh4FslpnQ`): "It pulled it from Pylon but didn't put the STC amounts or the inverter or panels into the quote." Then: the ROI is worked out in our app (the savings page already does it); Pylon is only for the design; the only parts of the Pylon link anyone looks at are the layout, the warranty documents and the data sheets; pricing and terms live in our app; and if Pylon cannot give the battery STC count, work it out from the usable kWh on the design.

Today the pull only saves `projects.pylon_data` and shows a summary on the proposal cover (spec A16, display only). System size and Battery usable kWh take Pylon's figures only into a blank field as the page loads; the equipment never becomes line items; the BSTC count is typed by hand. What Pylon's API gives per design: `summary.dc_output_kw`, `summary.storage_kwh` (usable), `summary.latest_snapshot_url` (the layout image), the web and PDF proposal links, and per panel, inverter and battery type a `sku`, `quantity`, `description` and `type_url`. No STC or BSTC counts.

1. **One pull fills the quote.** Pull from Pylon fills System size (kW), the battery's nominal kWh (as a hint beside Usable kWh, see point 3) and the proposal link straight away; a field that already holds a different typed figure shows "Pylon says 33.95, use it" next to it, one tap. The pull also adds one material line per Pylon item (panels, inverters, batteries, Pylon's quantity) to the first stage at $0 with the Needs a price tag; staff swap each for the Stock item with the existing Search material picker. Pulling again replaces the Pylon lines it added, never typed or priced ones. No Stock matching and no saved SKU (a later add-on if retyping annoys).
2. **Layout on the proposal.** The "Your system" page shows Pylon's layout image (`latest_snapshot_url`, copied into the quote's documents so it does not depend on Pylon's link staying up) instead of the "Pylon design and ROI" link. Data sheets and warranty documents: checked during the build whether Pylon's product endpoints (`type_url`) carry them; if so, they are filed in the quote's Documents on the pull, else staff attach them as now.
3. **Battery STCs worked out, from a usable figure we own.** Pylon's `storage_kwh` is the nominal size (ten SigenStor BAT 10.0 read 90.4, usable is 8.76 each, 87.6), so the usable kWh comes from a TEops list of battery models (new table `battery_models`: Pylon SKU, description, nominal kWh per unit, usable kWh per unit, entered by and when; Settings > Battery models card to see and correct it). The first pull that meets a battery not on the list asks once, "Usable kWh per SigenStor BAT 10.0?", from the data sheet or the CEC list; every later quote works it out by itself, quantity x usable per unit. If Pylon's battery product record (`type_url`) carries a usable figure it is offered as the suggestion, never used on its own. The BSTC block shows the working, "87.6 kWh usable = 10 x 8.76, SigenStor BAT 10.0, entered 6 Nov 2026", an install date, and the count: usable kWh capped at 50, split into the program's tiers, each tier times its share of the period's factor, rounded down. A typed count or a typed usable figure wins and the page says it differs from the worked one. The factors and tiers are data in Settings (new "Battery STC factors" card on the Terms tab, one row per period: from date, factor per usable kWh, tier 1 to 14 kWh %, tier 14 to 28 kWh %, tier 28 to 50 kWh %), seeded by the migration with the DCCEEW schedule (confirmed 6 Nov 2026 from the government's Cheaper Home Batteries page): 9.3 flat to 31 Dec 2025; 8.4 flat 1 Jan to 30 Apr 2026; then tiered at 100% (0 to 14 kWh), 60% (over 14 to 28 kWh) and 15% (over 28 to 50 kWh) with the factor 6.8 from 1 May 2026, 5.7 from 1 Jan 2027, 5.2 from 1 Jul 2027, 4.6 from 1 Jan 2028, 4.1 from 1 Jul 2028, 3.6 from 1 Jan 2029, 3.1 from 1 Jul 2029, 2.6 from 1 Jan 2030, 2.1 from 1 Jul 2030. Worked example for the Matilda Road design (87.6 kWh usable, installed 2026 after 1 May): 50 kWh counted, 14 x 6.8 + 14 x 6.8 x 0.6 + 22 x 6.8 x 0.15 = 95.2 + 57.12 + 22.44 = 174.76, rounded down to 174 STCs. The proposal and the ROI keep using the BSTC credit as now (count x $ per STC, capped on the server).
4. **Field renamed** "Pylon design ID", hint: "the last part of the Pylon address bar, after /map/edit/<project>/".

Migration (one): `battery_models` (fast RLS, read by authenticated, written by pricing roles, index on `pylon_sku`), `company_settings.bstc_factors jsonb` seeded as above. `projects.battery_kwh` keeps the usable figure. No money function changes (the credit cap stays as it is), no stock, RLS beyond the new table, or payroll change.

Done means: on staging (admin@staging.test, the real Pylon key entered once in Settings > API Keys on the staging site) (1) open a Solar quote, paste `Voh4FslpnQ`, Pull from Pylon: System size 33.95, the hint "Pylon: 90.4 kWh nominal" beside Usable kWh, proposal link filled, three $0 lines on the first stage with quantities 70, 2 and 10, each tagged Needs a price; (2) the BSTC block shows the count worked out from 50 kWh (capped) at today's factor and tiers, and the $ total; type a count and it wins; (3) Settings > Terms > Battery STC factors shows the four periods and a changed share changes the count on the quote; (4) the proposal's Your system page shows the Pylon layout image and no Pylon link; (5) pull again after pricing the panel line: the panel line keeps its price, the other two are replaced; (6) the field reads Pylon design ID.

Touches: `public/project.html` (step 3 Pylon card and BSTC block, pull handler, label, script tag, `?v=` bump), `public/js/pylon-equipment.js` (new: figures, lines, layout file and data sheets from `pylon_data`), `public/js/supabase-client.js` (`calculateBstcQuantity` next to `calculateStcQuantity`), `public/settings.html` (Battery STC factors card on the Terms tab, Battery models card, load and save), `public/quote.html` (layout image on Your system, link removed), `netlify/functions/pylon-sync.js` (file the layout image and any data sheets into the quote's documents), one migration (`battery_models` table, `company_settings.bstc_factors`), `docs/PROJECT_SPEC.md` A16 and the battery compliance doc.
Overlaps: none (6 Nov 2026: no unmerged branches; open PRs 297 docs and 34 email workers touch other files; item 59 touches `project-invoice-actuals.js` and the Terms tab of `settings.html`, so if 57 is built first this one adds its card below 57's).
Kind: feature into `staging`; migration yes; money yes (the BSTC count feeds the credit shown to the client, though the cap and claim functions do not change), stock no, RLS no, payroll no.
Size: medium to large (a day).
Best model: Fable 5.1, effort xhigh, because a migration and the client's credit figure ship together.

## 62. Pipeline moves done by the database (planned 9 Nov 2026, waiting on the owner's yes)

**What the check found (9 Nov 2026, production, read only).** The moves that happen in the database or on the server work: Ready to Book and Job Booked follow bookings and clock-ins (triggers, nightly sweep), a quote approval makes the job and the deposit, a paid deposit moves it on (J7057), a final claim moves Ready to Invoice to Awaiting Payment (J7056), Complete archives after 2 days. The moves that only run in the browser get skipped:

- **Awaiting Our Action with nothing open:** J7009, J7010, J7034 have no open required-before-scheduling task but sit at Awaiting Our Action. The gate (`refreshPipelineTaskGate`) only runs when a task is ticked on the job page, Tasks or My Day; a task deleted, made not required, or finished another way never re-runs it.
- **Client Handover with nothing left to do:** J7001, J7005, J7038, J7046 (direct jobs, no tasks at all) have sat at Client Handover since their clock-out "Complete". The handover check (`checkAndAdvanceHandover`) only runs when a handover task is ticked or the handover card is saved, so a job with no handover tasks never moves. J7012 was invoiced from Client Handover and stayed there.
- **Invoiced no-quote jobs never reach Awaiting Payment:** `create-invoice.js` only moves a job when the claim is "final", which needs a quoted total; a do-and-charge job ($0 quoted) is never final. J7012 and J7068 are invoiced and still at Client Handover and Ready to Invoice.
- **Paid only by webhook:** only the Xero and Airwallex webhooks set `paid_at` and run the all-paid check. SI3003 to SI3006 are not in Xero, so their jobs can never reach Complete by themselves. PR 316 (item 61) does not add mark paid by hand either.
- **Jobs in quote columns:** the board offers every column to a job, so J7036 sits at Quote Sent and J7037 at Lead (ServiceM8 imports moved by hand). J7031 is at Awaiting Payment with no invoice in the app (invoiced in ServiceM8). Board moves are not written to the activity log, so there is no trail.
- By design and left alone: Job Not Complete is hand-moved only (J7004 since 22 Oct, J7014 and J7051 have people booked or clocked in).

**Plan.** One migration moves the three browser-only checks into the database so every route (page, board, server, SQL, a future mark-paid button) lands a job in the right column, and each automatic move writes an activity line ("Moved to Ready to Book: no required tasks open", `changed_by` null):

1. `project_handover_ready(p_project_id)`: the same rule as `checkAndAdvanceHandover` (no open handover task; solar also NMI, panel and inverter serials and a Formbay status; battery NMI and Formbay).
2. `job_tasks_sync_stage` trigger (after insert, update, delete on `job_tasks`): the job at Awaiting Our Action or Ready to Book takes `project_unbooked_stage`; at Client Handover it moves to Ready to Invoice when `project_handover_ready`.
3. `projects_stage_rules` before-update trigger on `projects`: a job entering Client Handover, or one at Client Handover whose NMI, serials or Formbay status change, moves on to Ready to Invoice when ready (so the clock-out "Complete" on a direct job lands at Ready to Invoice).
4. `invoices_sync_complete` trigger (after update of `paid_at` on `invoices`): a job at Awaiting Payment with every invoice paid moves to Complete, whichever way the invoice was marked paid.
5. `create-invoice.js`: an invoice on a job with no quoted total raised while the job is at Client Handover or Ready to Invoice moves it to Awaiting Payment (it is the invoice for the work); a final claim raised from Client Handover moves it too. Job Not Complete stays put (work still going).
6. `dashboard.html`: Lead, Draft Quote and Quote Sent offered to quotes only, and a board move writes an activity line.
7. Delete `checkAndAdvanceHandover` and `refreshPipelineTaskGate` and their calls (`project.html`, `tasks.html`, `my-day.html`, `assets.js`): the triggers do the work. The clock-out message says which column the job landed in.
8. One-off in the migration: J7009, J7010, J7034 to Ready to Book; J7001, J7005, J7038, J7046 to Ready to Invoice; J7012 and J7068 to Awaiting Payment; J7036 and J7037 to Ready to Book. J7031 is left for the owner (Complete, or Archived).

**Done means:** (1) tick the last required task on a job at Awaiting Our Action from the Tasks page: the board shows it at Ready to Book with an activity line; (2) delete that task instead: same result; (3) clock out of a direct job with no tasks and tap Complete: the job lands at Ready to Invoice; (4) raise an invoice on a no-quote job at Ready to Invoice: it lands at Awaiting Payment; (5) set `paid_at` on that invoice by SQL on staging: it lands at Complete; (6) a job card on the board no longer offers Lead, Draft Quote or Quote Sent.

Touches: one migration (`job_tasks_sync_stage`, `projects_stage_rules`, `invoices_sync_complete`, `project_handover_ready`, the 11 job moves), `public/js/supabase-client.js` (delete two functions, clock-out message, `?v=` bump on every page), `public/project.html`, `public/tasks.html`, `public/my-day.html`, `public/js/assets.js`, `public/dashboard.html`, `netlify/functions/create-invoice.js` (the stage block only), `docs/PROJECT_SPEC.md` A6. Overlaps: PR 316 (item 61, open) touches `create-invoice.js`, `project.html` and both webhooks; build this after 316 merges, or in the same chat; no unmerged branches on `staging`; nothing waiting on yes touches these. Kind: bug fix (jobs not moving is wrong on live) into `main`, then `main` into `staging`; migration yes; money no (stage only), stock no, RLS no, payroll no. Size: medium (a morning). Test on staging: admin@staging.test, the six Done means clicks; no keys needed. Best model: Fable 5.1, effort xhigh, because it is a migration with triggers on the live jobs table plus code in one go.

## 69. simPRO quote into a TEops job (idea 9 Nov 2026, waiting on the owner's yes; was numbered 66 for a few hours, 66 is the interest item)

Owner, 9 Nov 2026: "Is there a way to get a quote out of simPRO and fill out a job in TEops with the quote data?" Yes. TEops already does this for ServiceM8 (spec A27): a review screen shows each quote or job as it would come across (client match, site, name, lines, quoted amount), the admin ticks the rows, and `sm8-import-jobs.js` makes the job the same way an approved quote does (one stage, labour lines on the matching rate tier at sell, materials at cost, the markup worked out so the stage sells for exactly the quoted figure, `stageFromLines`). A simPRO import is that same screen fed from simPRO instead. Two ways in, cheapest first:

1. **A file from simPRO (no simPRO setup):** on the quote in simPRO, print or export it (the quote PDF, or the items spreadsheet if simPRO gives one with cost and sell) and drop the file on a new Settings > simPRO import screen (admin). Claude reads it the way the supplier invoice reader does (`_shared/supplier-invoice-ai.js` pattern: client, site, quote number, every section or cost centre, each line with quantity, cost, sell, labour or material), the review screen shows it with "AI read, check" on every line, the admin fixes anything wrong, picks the client (matched by name, or new) and the site, then presses Make job. A client PDF usually shows sell only, so materials come across at sell with 0% markup (as the ServiceM8 import does when there is no cost) unless the file has costs.
2. **simPRO's API (later, once simPRO is settled on):** simPRO has a REST API on each build (`https://<build>.simprosuite.com/api/v1.0`, OAuth2; turned on inside simPRO, key kept in Settings > API Keys like `servicem8` and `pylon`). The screen then lists simPRO quotes (last N months, like the ServiceM8 one) with their real sections, cost centres and items at cost and sell, so nothing is read by eye. One quote can take several calls (quote, then its cost centres, then each item type), so the screen loads lines a few quotes at a time as the ServiceM8 one does. Not verified against simPRO's own API reference this session (the cloud session cannot reach it); check `developer.simprogroup.com` before building.

Either way the job that lands is a normal TEops job: Quoted type (claims against the quoted amount, Invoice project), stage lines ready for POs and Stock, Ready to Book, with the simPRO quote number on the job so a re-run skips it and the Summary says where it came from. If the quote is not yet accepted it can land as a TEops Draft quote instead (tick on the review screen), approved the usual way. simPRO is a quoting tool here only: nothing is written back to simPRO, and TEops owns the job from then on.

To decide before building: whether the quotes will keep being written in simPRO at all (TEops quotes have prebuilds, commercial agreements and the proposal PDF; simPRO's estimating and takeoff are the reason to keep it for big commercial jobs), and which simPRO export the owner can actually produce (a quick screenshot of simPRO's print and export options on one quote answers it).

**Done means** (staging, admin@staging.test, Settings > simPRO import): (1) drop a simPRO quote PDF on the screen: the client, site, quote number and every line show within a minute, each tagged "AI read, check"; (2) fix one quantity and untag it, pick the client, press Make job: a J number opens at Ready to Book with one stage whose total equals the simPRO quote ex GST; (3) the stage's lines show labour on a rate tier and materials with quantity and cost; (4) drop the same PDF again: the screen says it is already J####; (5) Invoice project on that job offers the quoted amount.

Touches (way 1): new `public/simpro-import.html` (copied from `sm8-import.html`, the review table and Make job), new `netlify/functions/simpro-import-extract.js` (admin, Claude reads the file), new `agents/prompts/simpro-quote.js` (the reading prompt), `netlify/functions/_shared/sm8-import.js` (the job-from-lines part moved to `_shared/job-from-lines.js` so both imports share it; `sm8-import-jobs.js` keeps working), `public/settings.html` (one link under Admin, no inline code), one migration (`projects.simpro_quote_number`, a column and an index, so a re-run skips a quote already brought across), `docs/PROJECT_SPEC.md` (A27 gains a simPRO paragraph). Way 2 adds `netlify/functions/simpro-import-preview.js` and `simpro-import-lines.js` and the `simpro` key in Settings > API Keys. Overlaps: none (no unmerged branch or open PR touches `sm8-import.html` or `_shared/sm8-import.js`; `settings.html` gains one link only). Kind: feature (into `staging`); migration yes (one column); money no (a job's quoted figure is set, nothing is invoiced), stock no, RLS no, payroll no. Size: medium (a morning for way 1; way 2 a day once the simPRO key exists). Test on staging: admin@staging.test, the five clicks above; needs the Anthropic key on staging (already there for the invoice reader). Best model: Opus 5.5, effort high, because it is a feature build that reuses an existing import path and an existing AI reader; nothing touches money or RLS.

## 74. Client portal: builders and repeat clients see their quotes and jobs, ask for work, message us, and refer jobs for a reward (planned 11 Nov 2026, every answer in, waiting on "yes, build")

Building in: `feat/client-portal` (owner's yes 11 Nov 2026). **PR 1 built 11 Nov 2026 (PR 377 into `staging`, spec A35):** login by email and password (a temporary one emailed when a contact is ticked, changed on first login, the code as the forgot-password path; owner's change the same day), the lists, the job page, the photo and document ticks, invoices, work so far, the Clients page tick, Send login and Portal off, and the usage log (owner's add the same day: every login and open recorded, the Clients card, the job activity log and the digest). Still to build: PR 2 (requests for work with due dates and suggested dates, messages on the Feed tab, the People card, the portal link in client emails and on the proposal and invoice pages), PR 3 (the referral link and lead rewards, staff links and KPIs, the review ask on site, the Rewards settings and the two scheme documents).

Owner's ask (11 Nov 2026): a page for the builders and clients who use us often, where they log in and see their quotes and jobs and what each is up to, request quotes and book in work, see the progress of a quote or job, see when we are scheduled, see whether anyone is clocked in on one of their jobs right now, see only the photos we have ticked for them, see no quote pricing until we have sent the quote, see our Schedule of Rates and any other documents we allow, and on do and charge jobs see the hours logged so far. Owner's answers (11 Nov 2026, second round) are folded in below and marked **Owner**.

**What exists today (surveyed 11 Nov 2026):** there is no client login of any kind. Clients only ever get token links: the proposal (`quote.html?token=`, `get_quote_by_token`), a fixed variation (`quote.html?variation=`), the invoice (`invoice.html?token=`, `get_invoice_by_token_v3`, Pay online), pick a time (`pick-time.html`), the review page, the Schedule of Rates and the commercial agreement letter (`rates.html`). Every row-level security policy assumes a logged-in user is staff (`to authenticated using (true)` on `projects`, `project_photos`, `project_documents`, `schedule_assignments`, `activity_log`, `profiles` and more), and `profiles.role` allows only admin, finance, sales and staff. So a client can never be an ordinary login: the portal works the way the token pages do, through server code that returns only what that client may see. No photo or document has a client-visible flag today. Hours on a job are `time_entries` (clock in, clock out, `billable`), a do and charge job is `proposal_template = 'direct_job'`, `get-invoiceable-actuals.js` already prices a do and charge job's labour (Schedule of Rates at the client's agreement, split into bands) and materials (cost plus the stage's markup), purchase orders carry `status` ordered, received, invoiced, paid, `get_active_clock_ins()` answers who is on site now, and the job's Feed tab (`feed_posts` with `project_id`, `feed_comments`, `feed_post_photos`) is where a message can sit.

**Plan:**

1. **Who gets in.** **Owner:** we tick "Portal" on a client's contacts, and the client's main email can let others in. So: `client_contacts.portal_access` (ticked on the Clients page; the client's main email, `clients.email`, is always in); a person logged in with the main email sees a People card where they add or remove emails (each becomes a contact with the tick, shown to staff on the Clients page, removable by staff). **Owner:** a site contact on a job (`job_contacts` with an email, a builder's supervisor) can log in too and sees that one job only: progress, bookings, who is on site, shared photos and documents, messages; never invoices, hours, costs, purchase orders or the Schedule of Rates (money stays with the people on the client record). Any client, residential too (**Owner**). A staff email is refused and told to use the app. "Portal off" on the Clients page (one button, a reason) shuts a client out and ends every session of theirs at once.
2. **Login by email and password (owner, 11 Nov 2026, replacing the code-only login).** Username is the email; a temporary password is emailed by itself when a contact is ticked Portal (and from Send login on the card or Send portal login on a job contact); the first login asks for their own; the email code stays as the forgot-password path and always ends on Choose your password; a usage log on our end (logins, views, opens) on the Clients card, the job's activity log and the digest. As first planned: The person types their email, gets a 6 digit code from sales@ (`portal-login.js`, the Gmail sending every client email uses, not recorded on a job), types it, and that device stays logged in for 30 days (a code again after that, or on a new device). No password exists, so nobody can reuse a leaked one and nobody at Thomson Energy resets anything; "Log out" and "Log out everywhere" on the page. Tables `portal_logins` (email, code hash, expires, attempts, used) and `portal_sessions` (token hash, email, client ids, created, last seen, expires, device, ended). One email on two clients sees both with a switch at the top.
3. **One page, `public/portal.html` and `public/js/portal.js`**, phone first, the proposal page's look. Top: "Needs you" (a quote to approve, a variation to sign, a time to pick, an invoice overdue, a message from us), each a button to the existing token page or the job. Then **Jobs** (open first, finished behind "Show finished") and **Quotes**, each row with the number, name, site, and one plain status line from `pipeline_stage` and the bookings: "Quote being prepared, due Thu 20 Nov", "Quote sent, waiting on you", "Approved, deposit to pay", "Being booked", "Booked for Tue 18 Nov, Cooper and Guy", "On site now: Cooper since 7:42am", "Work finished, invoice to come", "Invoice sent", "Paid", "Complete". Internal stages (Awaiting Our Action, Ready to Invoice) never show as such.
4. **A job's page** (`portal.html?job=`): the status line, the site, the site manager's first name and the office number (never a tradie's mobile), the next bookings (date, start and finish, first names; only bookings marked Client informed, tentative ones stay hidden by the rule that already exists), who is on site now, the ticked photos, the shared documents, the messages (point 8), the invoices with status and Pay online. **Owner:** a quoted job shows progression only. A do and charge job (`direct_job`, and do and charge variations on a quoted job) also shows **Work so far**: labour as one line per clocked day (first name, hours, standard or after hours, $ at the Schedule of Rates with their agreement, invoiced yet or not), materials used so far at the price they would be invoiced (cost plus the stage's markup, the same maths as `get-invoiceable-actuals.js`, reused not copied), and the job's purchase orders (PO number, supplier, what is on it, total at the client's price, and "Ordered, waiting for pickup", "Picked up", "Invoiced"), with a running "About $X not yet invoiced". Our supplier cost price never appears.
5. **Quotes** link to the proposal once sent (`sent_at` set); before that the row says "Being prepared" with the due date. A draft quote's prices are never returned by the portal code, not just hidden on the page.
6. **Photos the client may see.** **Owner:** hidden until ticked. `project_photos.client_visible` (false by default), a tick per photo on the job's Photos tab and "Share ticked with client"; a shared photo shows a small eye. Proposal cover and reference photos are already the client's.
7. **Documents the client may see.** `project_documents.client_visible` (false by default), a tick per document on the Documents tab. Visible by itself, no tick needed: anything we have already sent them (the quote PDF once sent, every invoice PDF, signed variations, the commercial agreement letter), anything they uploaded themselves, and the Schedule of Rates page at their agreement (`get_schedule_of_rates`, `get_commercial_agreement`). Internal uploads (plans with notes, supplier bills, markups, bill readings) stay hidden unless ticked.
8. **Messages on the job.** **Owner:** they land on the job's Feed tab, shown apart from team chat; and we can tick "Email client" (and later "Text client") on a post so it reaches them and shows in the portal too. So: `feed_posts.client_visible` (true on a post from the client, and on ours when the tick is on), `feed_posts.from_client_email`, `feed_posts.sent_to_client_at`. The Feed tab shows client-visible posts in their own strip with a Client badge; a ticked post emails the client through the usual sending (recorded on the job) and the portal shows the thread. A client's post notifies the site manager and the office like a feed mention does. Text comes with item 7 (Twilio).
9. **Request work.** **Owner:** quotes and do and charge; a quote request becomes a draft quote at once, with a due date the client sets, and they can keep adding information and documents to it; we can extend the due date when we cannot make it. A do and charge request lets them suggest booking dates and we confirm. So one form: which site (their saved sites, or a new address, saved as a site), what they need, photos and documents, and either **Quote it** (plus "Needed by", `projects.client_due_date`) or **Book it in** (plus one to three suggested dates, `projects.client_suggested_dates`; offered only to a client with a commercial agreement or a do and charge job already). Quote it draws the next Q number through the same code `new-project.html` uses, client and site linked, their words as the pre-quote notes, their files in a "From client" folder (`project_documents`, visible to them by itself), and notifies the office; the Quotes page shows "From the portal, due 20 Nov"; while it is a draft the client can add more notes and files from the portal (never edit ours). **Extend:** on step 1 a pricing role sets a new due date with a reason; the client sees "Now due Mon 24 Nov" and gets an email. Book it in draws the next J number as a do and charge job in Awaiting Our Action with "Requested by client" and the dates; the Schedule tab shows "Client asked for Tue 18 or Wed 19" as chips, booking one of them and marking Client informed sends the confirmation exactly as today, and the portal flips to "Booked". Nothing new for staff beyond the chips and the due date.
10. **What the portal never shows:** our supplier cost prices, margins, wages, supplier bills, stock, internal notes, time entry notes, incidents, team chat, feed posts not ticked, staff surnames and mobiles, other clients' anything, tentative bookings, draft quote prices, hours on fixed price jobs, bill readings beyond what the proposal already prints, the AI's summaries.
11. **One door, server side.** **Owner:** check security, this could be a weak point. So every portal read and write goes through Netlify functions, never anon table access and no new anon-callable SQL functions: `portal-login.js` (send code, check code, log out), `portal-read.js` (overview, job, work so far), `portal-write.js` (request, message, upload, people). All three call `_shared/portal-session.js` first (one place that checks the token, the client scope, the rate limits and writes the log) and `_shared/portal-data.js` (the whitelisted queries). The staff side (ticks, extend, chips) is ordinary RLS work by pricing roles. Every login, failed code, request, upload and message is written to `activity_log` against the client; the Clients page shows "Last in the portal: 3 Nov" and the ops digest counts failed logins.

**Security check (11 Nov 2026), the weak points and what the design does about each:**

- **Guessing a code.** 6 digits, 10 minutes, one live code per email, 5 wrong tries then the code is dead and a new one is needed, at most 3 codes per email per hour and 20 per IP per hour, the code stored hashed. The reply is the same whether or not the email is known ("If that email is on a client record, a code is on its way"), so nobody can list our clients by trying emails.
- **Stealing a session.** The device holds a 32 byte random token; the table holds only its hash; 30 days then a code again; "Log out everywhere" ends every session; Portal off ends them for the client; every session row records the device and last seen. No token ever goes in a link or an email (the portal link in emails is plain `/portal.html`).
- **Seeing another client's data.** The scope is worked out on the server from the session (client ids from the contact tick, job ids from `job_contacts`), every query carries it, every field is named on a whitelist, and the smoke run proves three things on every build: a draft quote returns no prices, another client's job id returns nothing, a job contact's call returns no money fields.
- **Our prices leaking.** Materials and purchase orders show the client's price only, worked out by the same shared code the invoice uses; `unit_cost`, supplier bill lines and margins are never selected.
- **Public photo bucket.** `site-photos` is a public bucket today (anyone with a URL can open the photo, the paths are random). The portal lists ticked photos only, which is the same exposure every quote page has now. Hardening for a later item: a private bucket with short signed links.
- **Client uploads and text.** Files go only through `portal-write.js` into the private `project-documents` bucket under `portal/<client id>/`, images and PDFs only, 20 MB each, 10 per request, names escaped; every message and note goes through `escapeHtml()` wherever it is shown, 2,000 characters, 20 posts an hour. A client's text never reaches an AI action or a push to the whole team: the site manager and the office get the notice.
- **Abuse of the forms.** A request or a message is rate limited per session and per client; a shut-out client gets "Portal off" on every call; staff emails are refused.
- **Who can let people in.** Only the main email (`clients.email`) can add other emails, each addition is logged and visible to staff on the Clients page, and staff can untick anyone. Nobody can add themselves.
- **Existing staff rules untouched.** No policy changes, no new `to authenticated` rows, `enable_signup` stays as it is because the portal never creates an auth user.

**74b. Lead rewards: a client sends us a lead and gets a payment or a credit when we win it (owner's add, 11 Nov 2026).** **Owner:** some clients get an option to be paid or credited for a lead. They fill in a form in the portal (photos of the roof, switchboard or fault; the person's details; the job type, with questions we build per type: solar, battery, switchboard upgrade, fault find and so on) and send it through. We quote it; $1k to $5k they get $80, $5k to $15k a $200 credit, over $15k a $500 credit, nothing under $1k; and when we quote, the reward is hidden inside the cost.

1. **Who gets the option.** `clients.lead_reward_kind`: off (default), **pay** (bank transfer) or **credit** (taken off their next invoice), set on the Clients page. That switch is the owner's ask (some clients, not all). The tiers are data, not constants: `company_settings.lead_reward_tiers` (**Owner, 11 Nov 2026:** nothing under $1k, then `[{from: 1000, amount: 80}, {from: 5000, amount: 200}, {from: 15000, amount: 500}]`, for a full referral), `lead_reward_quick_amount` (a quick referral, $50), `staff_link_amount` ($50), `staff_site_lead_amount` ($0), `staff_under_budget_amount` ($100) and `lead_reward_min_job` ($1,000), editable under Settings > Company Details.
2. **The form is a link, no login.** **Owner (11 Nov 2026):** as easy as possible so they remember to do it. So each client with the option on gets a personal referral link, `refer.html?r=<clients.referral_token>`, that opens the form straight away: no code, no login, the referrer known from the link. They keep it on the phone's home screen, text it to their own staff, or stick the QR on the van. When the option is turned on, the client gets one email with the link, a QR card to print and a line to forward ("Know someone who needs solar, a switchboard or a fault fixed? Send it here"); the portal has the same button, and every job handover email to a rewarded client carries the link, so the reminder comes by itself. The link can only ever send a lead in that client's name (it reads nothing), 10 referrals an hour per link, and a junk lead costs nothing because the reward only ever pays on a job we win; Regenerate link on the Clients page if one gets passed around. Their referrals list (money on it) stays behind the portal login. The form: the job type (Solar, Battery, Switchboard upgrade, Fault find, Renovation, Service work, Other), then that type's questions, the person's name, phone, email and the site address, photos (roof, switchboard, the fault, through `compressImage()` into the private `lead-uploads` bucket), and a line they tick: "I have told this person Thomson Energy will contact them". The first question is **Who is this for?**: **Me** (their own job: it becomes their draft quote exactly as Quote it in point 9 of the portal plan, with a Needed by date) or **Someone else** (a referral). **Owner (11 Nov 2026): the link works for a business referral too, not always an inspection; a referral without the inspection earns a flat $50 or so.** So a referral is one of two kinds: **Quick** (who they are, their number, what they need, a line about it: 30 seconds, for a business contact or a name passed on at the pub) at a flat amount, `company_settings.lead_reward_quick_amount` ($50 to start, editable), or **Full** (the type's questions and the photos: the inspection) at the tiers. The form says the two amounts beside the choice so they know which to pick. The lead carries `leads.referral_kind` (`quick` or `full`) and the Quotes page shows it; a quick referral still earns nothing when the quote is under $1k. Three screens on a phone, under a minute. **Owner (11 Nov 2026):** once they fill in the link it shows on their portal as a quote. So both paths land in the portal's Quotes list straight away: their own job as a Q row with the usual status words; a referral as a "Referred: J. Smith, switchboard" row that gets its Q number once the office creates the quote, then "Being quoted", "Quoted", "Won: $200 credit once the deposit is paid", "Credit due", "Credited on INV-1234" or "Not won". A referral row never links to the proposal and never shows the price or the person's address beyond the suburb (it is someone else's quote). The questions are the plain-English subset of the quote's own type questions in `public/js/template-questions.js` (each question gains a `lead: true` mark, so a type's questions live in one place); Switchboard upgrade and Fault find are two new short sets on the Service work type. It lands as a lead (`leads.referrer_client_id`, `source = 'portal_referral'`, answers in `details`, photos in `details.attachments` as the website's do) through `portal-write.js` (the token checked there, never direct table access), the office is notified as for any lead, and Create quote from it carries the answers onto `projects.template_answers`, so nobody retypes them. The Quotes page's Pending leads shows "Referred by ABC Homes".
3. **The reward on the quote.** `projects.referrer_client_id` is set at Create quote from the lead. The first stage gets one line "Lead reward (ABC Homes)" with `cost_centre_line_items.internal = true`: **Owner: at cost exactly, hidden.** An internal line is added to the stage price after the markup, dollar for dollar (the markup never touches it), and is never printed on the proposal, the PDF, the breakdown, the invoice or the job's cost view for staff who are not pricing roles (`get_quote_by_token`, the quote PDF, the breakdown and `create-job-from-quote.js` carry it as internal; the stage maths in `public/js/supabase-client.js` and `_shared/invoice-items.js` add internal lines after markup). Its amount follows the tier of the quote's total before the line (**Owner: the total out of pocket to the client**: inc GST, after the STC and BSTC credits, the figure the proposal shows as payable), worked out again by the database whenever the lines change (`lead_reward_sync` trigger on `cost_centre_line_items`), so the Summary chip "Referred by ABC Homes: $200 credit if won" is always right and nobody adjusts it by hand. A tier is decided on the quote at approval and never moves after (variations do not change it).
4. **When it is owed.** `lead_rewards` (referrer_client_id, lead_id, project_id, amount, kind, status, earned_at, due_at, settled_at, invoice_id or paid_reference, created_at). **Owner (11 Nov 2026, final): owed once the deposit is paid, not at quote approval.** The row is made **earned** when the referred quote is approved (`accept-quote.js`, `manually-approve-quote.js`), the amount fixed then, and **due** when the referred job's deposit invoice is paid (or its first invoice, when the quote has no deposit), caught where payments already land (`airwallex-webhook.js`, `xero-webhook.js`, a paid date set by hand on the Invoices page). A referred quote that is declined or expires makes no row; a job that falls over before the deposit pays nothing, and the owner can cancel a row with a reason on the Lead rewards list. **Credit:** the next invoice raised to the referrer takes it by itself as a minus line "Lead credit, J7020: -$200" after any Less line (the same place `create-invoice.js` puts the commercial agreement line), marks the row settled with that invoice, and goes to Xero inside that invoice. **Pay:** a "Lead rewards" list on the Clients page (due first) with the referrer's bank details from their record, "Paid" with a reference and date, and a Xero spend money line to Advertising and Marketing (account code to confirm with the owner, it is not in `docs/BUSINESS_FACTS.md`).
5. **In the portal:** referrals sit in the Quotes list as point 2 says (no separate page to find), each with its status word and the amount, and a Rewards line at the top of the portal when anything is due or settled ("$200 credit due, taken off your next invoice").
6. **Rules that need no switch:** a referral whose phone or email matches the referrer's own record, or a client who already has an open quote or job with us at that address, earns nothing (the lead still comes through, marked "already a client"); one reward per lead; a reward is never earned twice when a quote is duplicated. The first email or call to the referred person says who passed on their details (the Privacy Act asks us to say where personal information came from).

7. **The same link for every staff member (owner's add, 11 Nov 2026).** Each person gets `profiles.referral_token` and the same form reached two ways. **In the app:** a "New lead" button on My Day and Home (the same `refer.js` form, the person already filled in; "Same customer as the job I'm on" copies the name, phone and site from the job they are clocked in to, for the customer who asks about solar while we are fixing their switchboard; photos from the phone there and then). **To send anyone:** their personal link `refer.html?s=<token>` (a friend or a neighbour fills it in, sees a thank-you, and nothing else). Both land as that person's lead (`leads.referrer_profile_id`): the Leads page shows "From Cooper", Create quote carries the answers and sets `projects.referrer_profile_id`. **KPIs:** the staff profile's KPIs card gets a Leads block worked out by the database for the period (sent, became quotes, won, won value, `staff_lead_stats(profile_id, from, to)`), and a KPI whose measure is "Leads sent" or "Leads won" shows that live figure as its result instead of a typed one, so nobody counts by hand. **Owner (11 Nov 2026, final): employees get $50, owed once the deposit is paid, for anyone they give the link to; a lead they fill in on site is KPIs only (they are paid to fill the form in); if they quoted the job too and it finishes under budget they get something as well; every amount editable in Settings.** So a staff lead from their link makes a `lead_rewards` row (kind `staff_link`, `company_settings.staff_link_amount`, $50) earned at approval and due when the deposit is paid, with the hidden line at cost on the quote like a client's; a lead entered in the app (`leads.entered_by` = the referrer) makes no money row (`staff_site_lead_amount`, $0, there if the owner ever wants it) and counts on the KPIs. **Under budget:** `projects.quoted_by` (defaults to the quote's `created_by`, changeable on step 1, carried to the job at approval). When a job moves to Complete, `job_budget_check(project_id)` compares what it cost us (labour at cost from `compute-labour-cost.js`, every material and PO line at cost) with what the quote allowed (every stage's `estimated_labour_cost` plus `estimated_material_cost`, approved variations included); at or under makes a row (kind `staff_under_budget`) for `quoted_by`. **Owner (11 Nov 2026): a percent of the saving, up to $500, and the client has to be happy, a 5 star review.** So the amount is `staff_under_budget_percent` (**2%**, owner 11 Nov 2026) of the saving (allowance less cost), capped at `staff_under_budget_cap` ($500), and the row is **earned** only when three things are true: the job is Complete and under budget, no defect or warranty job has been raised against it in its first 30 days, and the client's review for that job is at least `staff_under_budget_min_stars` (5 to start; the owner can set 4, or 0 for no review needed). **Asking for the review is one tap on site (owner, 11 Nov 2026: make it easy for the boys on site to ask):** when someone answers Complete at clock-out, the next screen is "Ask the customer for a review" with the job's review link as a big QR code to hold up (the customer scans it and taps the stars there and then, `review.html` already works on a phone) and a Send button that emails it from sales@ in that person's name (text when Twilio comes, item 7); **no clock-out needed (owner, 11 Nov 2026: they ask while packing up and clock out back at the shed):** while a person is clocked in, My Day's current job card has a Review button (**owner: My Day, not Home**), opening the same QR screen for the job they are on, any time; the clock-out screen only offers it again if nobody on the job has asked yet. **Whoever gets the review gets the credit (owner, 11 Nov 2026):** the QR code and the Send button make that person's own `review_requests` row for the job (`created_by` is already on the table; one row per person per job, the same job can have one for each person on it), so the review the customer submits is theirs. The staff profile's block becomes **Leads and reviews**: leads sent, became quotes, won and their value, then reviews asked, reviews received, 5 star reviews, average stars and how many went on to Google (`google_clicked_at`), for the period; a KPI measured as "Reviews received" or "5 star reviews" shows the live figure as its result. The job's Feed shows "Cooper got a 5 star review from Mrs Smith" and the team sees it on Home, because a review earned on site is worth a mention. The automatic request at Complete is credited to the site manager. **$5 per review (owner, 11 Nov 2026):** a review the customer submits on a person's own link makes a `lead_rewards` row (kind `staff_review`, `company_settings.staff_review_amount`, $5) earned at once, one per person per job, paid on the next pay run with the other bonuses; it is paid for any rating, not only 5 stars (paying for stars would push people to lean on customers, and the ACCC's guidance on reviews is against anything that buys or filters ratings), and never for the automatic request at Complete. Whatever they do, the link goes out by itself if nobody has sent it by the time the job moves to Complete (`sweep-job-complete-review.js`, same link as the composer makes), with one reminder after 7 days; today the link is only ever sent by hand from the email composer. The row sits as "Under budget $46 waiting on the review" on the staff profile until the review lands, and lapses after 60 days with no review (the owner can mark it earned by hand with a reason). Due when earned (no deposit step here), paid on the next pay run. The staff profile's Leads block shows each row as "Link bonus $50 due" or "Under budget $100 due" and when it was paid. **Paying it:** the fortnightly timesheet push (`push-timesheets-to-xero.js`) adds one earnings line "Lead bonus" per person for the rows due in that fortnight (a Xero pay item the owner creates once: Payroll settings > Pay items > Earnings > Add > Allowance, name "Lead bonus", type Other, taxed, super as the accountant says) and marks them settled with the pay run; until the pay item exists the push leaves the rows due and says so. **Every amount in one place:** Settings > Company Details > Rewards card (`public/js/settings-rewards.js`): the client tiers, the quick amount, the staff link amount, the on-site lead amount, the under budget amount, and the minimum job size ($1,000), all `company_settings` columns. **Shape as a setting (owner's question 11 Nov 2026, flat or a percent):** each staff bonus has a type (flat, percent of the job's total, or percent of the saving for under budget), a rate, a cap and a minimum (`company_settings.staff_bonus_rules` jsonb), so flat today can become a percent without a build. Owner's pick (11 Nov 2026): link bonus flat; under budget a percent of the saving capped at $500, with a 5 star review from the client, because the person who sets the estimate is the person paid for beating it and the review stops corner cutting. **Legal points (not advice, the adviser confirms):** a staff bonus is wages (super on it, PAYG, STP as bonuses and commissions, WorkCover wages, payroll tax wages if ever over the threshold, always on top of the award); the staff document says the scheme is discretionary, not a contract term, and can be changed or withdrawn without notice for anything not yet won (**owner, 11 Nov 2026**), while a bonus already earned is still paid because earned wages cannot be clawed back; the client document says the same for referrals; a "Scheme off" switch on the Rewards card stops new rewards the same minute and leaves earned ones to be paid; a builder's employee (a job contact) is never paid personally, their referral credits the client's account, because a personal payment for passing on their employer's work can be a secret commission under NSW and Queensland crimes law; a credit to a business is a discount on our invoice so GST adjusts itself, a cash payment to a GST-registered business needs their invoice, so businesses get credits and individuals may be paid. **Xero (owner's ask: a sales expense on the P&L):** one Expense account "Referral fees and sales bonuses" (the owner makes it: Accounting > Chart of accounts > Add account, type Expense); the Lead bonus pay item posts to it (Payroll settings > Pay items > Earnings > Lead bonus > Expense account); the client credit line on an invoice maps to it through the existing account mapping (`xero_account_mappings`, a new key `referral_fees`) so it is an expense, not less sales; client payments are Spend money to it. **Two documents (owner's ask):** drafted 11 Nov 2026 in `policies/` as "Thomson Energy Referral Rewards (Clients).txt" and "Thomson Energy Lead and Bonus Scheme (Staff).txt" for the owner's read; the build turns them into live documents that print the amounts from Settings on the day: the client one as `generate-client-document-pdf` type `referral_rewards`, sent with the link email and shown in the portal's documents; the staff one as an onboarding document every employee signs (`onboarding_documents`, the usual sign-off), re-issued when an amount changes. A staff member's link stops working the day they are made inactive.

Owner's answers on 74b (11 Nov 2026): (1) Owed once the deposit is paid (changed from quote approval the same day). (2) The tier reads the total out of pocket to the client (inc GST, after the credits). (3) At cost exactly, hidden. (4) KPIs only for now (they are paid to fill the form in), payroll bonus later: built so both work. **Answered by the owner 11 Nov 2026, folded in above and in point 7.**

Not in this plan: a client password, clients editing our quotes or jobs, clients approving do and charge variations, SMS codes and text messages (Twilio, item 7), a native app for clients, signed photo links, paying lead rewards through Airwallex payouts (item 22, needs the payout key).

Done means (staging): (1) `portal.html`, type a seed client's ticked email, get the code, log in: the client's jobs and quotes with plain statuses; another client's job id in the address bar shows nothing. (2) On a draft quote the portal shows no prices; send it from step 5: the row now links to the proposal. (3) Tick two photos on a job and Share: the portal shows those two only. (4) Book a job and mark Client informed: the portal shows the date and first names; clock in as staff@staging.test: "On site now". (5) On a direct job with a clocked shift and a PO, Work so far shows the day's hours at the Schedule of Rates, the PO as "Ordered, waiting for pickup" at the client's price, and "not yet invoiced". (6) Quote it from the portal with a due date and a PDF: the Quotes page shows the new Q "From the portal, due ...", the PDF is on its Documents tab; extend the date from step 1: the portal shows the new date. (7) Post a message in the portal: it is on the Feed tab with a Client badge; reply with Email client ticked: the portal shows the reply and the email goes. (8) Set a seed client to Credit, open their referral link in a private window (no login) and refer a job with photos, Create quote from the lead: the answers are on step 1, the first stage carries the internal line, the Summary chip says the tier; price it over $5k: the chip says $200; approve it: the reward is earned; pay its deposit invoice on staging: due, and the referrer's next invoice shows the minus line; send a quick referral from the same link: its row says $50; the portal's Quotes list shows the referral row at every step. (9) Log in as staff@staging.test, My Day > New lead with Same customer ticked: the lead is on the Leads page as From Staff with the job's details; open the staff member's own link in a private window and send one: a second lead; their staff profile's KPIs card shows Leads sent 2; approve a quote from the staff member's link lead: the profile shows "Link bonus $50 due" and the quote carries the internal line; mark a job they quoted Complete with its costs under the estimate: the review email goes to the client and the profile says "Under budget $46 waiting on the review"; at clock-out answer Complete: the QR screen shows; scan it and give 5 stars: "Under budget $46 due", and that person's profile shows Reviews received 1, 5 star 1, "Review $5 due"; Settings > Rewards: every amount is a box.

Touches: `public/project.html` (Photos, Documents and Feed tabs: the ticks and the client strip, Schedule chips, step 1 due date and Extend; all new code in `public/js/share-with-client.js` and `public/js/feed-client.js`), `public/clients.html` (Portal tick per contact, Portal off, last login, Lead reward option, the Lead rewards list in `public/js/lead-rewards.js`), `public/quotes.html` (From the portal and due date, Referred by), `public/js/template-questions.js` (the `lead` marks and two new sets), `public/leads.html` (referrer shown, answers carried to the quote), `public/settings.html` (the Rewards card, in `public/js/settings-rewards.js`), `public/onboarding.html` and the onboarding documents (the staff scheme document), `policies/` (the two drafts, already in), `netlify/functions/accept-quote.js` and `manually-approve-quote.js` (the earned row), `create-invoice.js` (the credit line), `push-timesheets-to-xero.js` (the Lead bonus earnings line), `sweep-job-complete-review.js` (new, the automatic review request), `public/my-day.html` and the clock-out flow in `public/js/supabase-client.js` (the Review screen, in `public/js/review-ask.js`), `submit-review.js` (a review earns a waiting bonus), `airwallex-webhook.js`, `xero-webhook.js` and the Invoices page paid action (the deposit makes the reward due), `generate-client-document-pdf.js` and `get_quote_by_token` (skip internal lines), `public/js/supabase-client.js` (`clientPages` list, feed post tick, `?v=` bump on every page), `public/portal.html` (new), `public/js/portal.js` (new), `public/refer.html` and `public/js/refer.js` (new, the link form, also the New lead button's form), `public/my-day.html` and `public/home.html` (one New lead button each, no inline code), `public/staff.html` (Leads and reviews block on the KPIs card, in `public/js/staff-leads.js`), `public/css/style.css` (portal styles), `netlify/functions/portal-login.js`, `portal-read.js`, `portal-write.js` (new), `_shared/portal-session.js`, `_shared/portal-data.js` (new), `_shared/invoice-items.js` or `get-invoiceable-actuals.js` (the labour and material maths pulled into `_shared/job-actuals.js` so the portal reuses it), `_shared/send-recorded-email.js` (the client post email, the footer link), `scripts/smoke.js` steps, one migration (`client_contacts.portal_access`, `clients.portal_off_at` and reason, `project_photos.client_visible`, `project_documents.client_visible`, `feed_posts.client_visible`, `from_client_email`, `sent_to_client_at`, `projects.client_due_date`, `client_due_date_reason`, `client_suggested_dates`, `requested_via_portal_at`, `portal_logins`, `portal_sessions`, `clients.lead_reward_kind`, `clients.referral_token`, `profiles.referral_token`, `leads.referrer_profile_id`, `leads.referral_kind`, `projects.referrer_profile_id`, `staff_lead_stats`, `projects.quoted_by`, `leads.entered_by`, `job_budget_check`, `company_settings.lead_reward_quick_amount`, `staff_link_amount`, `staff_site_lead_amount`, `staff_under_budget_percent`, `staff_under_budget_cap`, `staff_under_budget_min_stars`, `staff_review_amount`, `staff_bonus_rules`, `lead_reward_min_job`, the `referral_fees` account mapping, `company_settings.lead_reward_tiers`, `leads.referrer_client_id`, `projects.referrer_client_id`, `cost_centre_line_items.internal`, `lead_rewards`, `lead_reward_sync` trigger), `docs/PROJECT_SPEC.md` (new part for the portal). Overlaps: item 73 (building, PR into `staging`) touches the job's Photos tab and `project_photos` (AI tags): build the photo tick after 73 merges, or in that chat; item 53 (waiting on yes) touches `project.html` Emails tab, not these tabs; item 62 (waiting on yes) moves jobs between stages by trigger, the portal only reads `pipeline_stage`; no unmerged branches on `staging`; open PR 34 is the old email workers. Kind: feature (into `staging`); migration yes; money yes from 74b (a hidden cost on quotes, a minus line on invoices, rewards paid out: backup before the production migration), stock no, RLS yes (`lead_rewards` read by pricing roles and by a staff member for their own rows, written by the server; the portal tables server only), payroll yes (the Lead bonus earnings line on the fortnightly push, after the owner makes the pay item in Xero). Size: large (three to four days, best as three PRs: login, lists, job page, photos, documents, invoices and work so far; then requests, messages and people; then lead rewards). Test on staging: staff logins for the staff side, a seed client's email for the portal side (the code is read from the staging Gmail or the `portal_logins` row); Gmail key on staging for the code and the client emails. Simpler: a builder no longer rings to ask when we are coming, who is on site, where the invoice is, what the job has cost so far, when the gear arrives, or for photos; the office no longer emails photos and documents one by one, writes up a phoned-in quote request, or chases a client for the plans (they upload them to the draft); a work request arrives as a Q or J with the client, site, files and dates already on it; a referred lead (from a client or one of our own people, on site or by their link) arrives with its photos and answers already on the quote, a staff member's lead count fills its own KPI, the reward prices itself into the quote, falls due by itself when the deposit is paid, and a credit takes itself off the next invoice. Still by hand: the photo and document ticks (the owner's ask, so internal plans never leak), the Portal tick per contact (the owner's ask, so a client chooses who sees money), the Email client tick on a post (so team talk stays private), Portal off for a client in dispute, the Lead reward option per client (the owner's ask, some clients only), marking a bank transfer reward Paid (Airwallex payouts later), and the one-off Lead bonus pay item in Xero before the first pay run with a bonus. Best model: Fable 5.1, effort xhigh, because it opens client data to the outside through one new door, puts a hidden cost into quotes and a credit onto invoices, and carries a migration.

## 77. Whole screen on every page (owner's rule 12 Nov 2026; built 13 Nov 2026, PR 431, on `staging`)

**Owner, 12 Nov 2026:** make it a rule that we always use the whole screen, so there is no wasted page. Rather than scrolling through so much, put things next to each other: the job Summary tab could have the tasks far left and the summary in the middle. **Later the same day:** fix all the pages at once: fit the whole screen, minimise scrolling, size everything only as big as it needs to be, and columns left to right rather than one thing stretched across the whole screen.

The rule is in `CLAUDE.md` (How the owner works, "Use the whole screen") and the `/code-structure` skill. Inbox (item 76) was the first page, live 12 Nov 2026.

**Found (survey of all 60 pages, 12 Nov 2026):** 55 pages sit in `.wrap` (1100px wide, or 1400px with `wide`) centred with 32px padding, so a laptop shows a strip down the middle with empty sides. No page except Chat and Inbox splits into columns that scroll on their own: every page stacks full-width cards and the whole window scrolls. Worst for scrolling: Timesheets (nine cards stacked), Overheads, STCs, Leads, Stock, Bugs, Ops, Tasks, Knowledge, Logs, My Day, Prebuilds, the job page. Sizes are oversized for a laptop: topbar 76px, card padding 22px with 20px between cards, buttons 10px by 18px, table cells 10px tall padding, stat tiles 24px numbers.

**Building in: `claude/bold-albattani-b268hw` (owner's "Yes build", 13 Nov 2026), one PR into `staging` with the four parts as four commits (a cloud session pushes one branch, and the owner checks the preview once).** PR 431, waiting for the owner's clicks on its Deploy Preview before it merges into `staging`. As built: see `docs/PROJECT_SPEC.md` A5 and A17.

**Plan: four PRs in one chat, in order, each into `staging`, no migration.**

**PR 1, the frame and the sizes (every page at once, `style.css` only plus the `?v=` bump).**
- `.wrap` and `.wrap.wide` lose their width cap and centring: 16px by 20px padding, edge to edge. `.wrap.narrow` (720px) for the pages that are reading or signing: Onboarding, Policy update, Site inspection. Pages with their own inline width keep it (login 420, portal 720, pick-time 640, rates and the client documents 860).
- Practical sizes on a laptop: topbar 60px (logo 40px), card padding 14px and 12px between cards, h1 20px and h2 15px, subtitle gap 12px, tables 13px with 6px cell padding, stat tiles 10px padding with 20px numbers, inputs 7px by 10px, buttons 7px by 14px, labels 10px above, grid gap 12px. Phones keep what they have: the touch rules (44px buttons, 16px inputs) stay as they are.
- One shared column frame, used by every page from PR 2 on: `.page-cols` is a grid under the topbar as tall as the window (`100dvh` minus the topbar, like `.inbox-app`), each `.page-col` scrolls on its own, a `.page-head` strip above it holds the title and the buttons on one line. On a phone the frame stacks to one column and the page scrolls as now. Column widths are set per page with a class (`cols-3-1`, `cols-1-1`, `cols-side` for a 300px rail and so on), nothing new per page in CSS.
- Done means: (1) Jobs on a laptop runs edge to edge with no empty sides. (2) Every page's topbar is shorter and the first row of a table is on screen without scrolling. (3) On a phone, buttons are still finger sized and nothing has moved. (4) Login, the portal, a proposal link and an invoice link look exactly as before.

**PR 2, the job page (`project.html`, class changes only, no new inline code; its budget goes down).**
- The job header (name, client, status) and the tab bar stay put at the top; the search box moves onto the header line.
- Summary tab: Tasks far left (300px), the summary cards in the middle in two columns, the Activity log on the right (320px); each column scrolls on its own.
- Every other tab: the tab's content in the middle, the Activity log on the right, so the log is always in reach.
- Quote tab: the steps bar becomes a left rail (the five steps with their ticks), the step's cards in the middle, and the Quote and client card plus Send and the ready-to-send check on the right; the tall text boxes (scope, terms) sit side by side in step 4; the STC and BSTC credits and the payment schedule sit beside the stages in step 3.
- Done means: (1) J7002 Summary: Tasks, summary and Activity log side by side, the Tasks list scrolls without the header moving. (2) Switch tab: the Activity log stays on the right. (3) A quote: the five steps on the left, click 3 Pricing and the stages are there with the credits beside them. (4) On a phone: tabs and cards stacked as now, Tasks first.

**PR 3, the pages people sit on longest, each on the frame.**
- Tasks: three columns, Assigned to you, Your role, Up for grabs.
- Leads: Call requests, Enquiries, Site interest (folded by default); the lead opens in the third column instead of a popup.
- Timesheets: My week, Team week (with lunch breaks under it), then Leave and approvals and Push to Xero in the third.
- Stock: Materials (the big table) on the left, Stock checks and Stock purchase orders on the right.
- My Day: Clock and Your schedule on the left, Your scheduled tasks in the middle, Free tasks on the right.
- Home: the shortcuts at the practical size on one line, My schedule and Needs attention on the left, the Company feed on the right scrolling on its own.
- Clients: the list on the left, the client's details and sites on the right, no tab switch.
- Settings: the tab rail stays on the left, the panel scrolls on its own, and the long panels (My Profile, Company Details, API Keys, Xero Mapping, Users and Roles) lay their cards two across.
- Schedule: the calendar fills the window height (month cells grow to fit six weeks), the day board's job search stays on the right.
- Pipeline: the board runs edge to edge so more stages fit before sideways scrolling, columns as tall as the window.
- Done means: (1) Tasks: three lists side by side, no page scroll. (2) Leads: click an enquiry and it opens on the right. (3) Timesheets: this week's hours, the team's week and the leave approvals all on screen at once. (4) Settings > My Profile: cards two across, the rail stays while the panel scrolls. (5) Schedule month view: six weeks fit without scrolling the page.

**PR 4, the rest, each on the frame.**
- Two columns: Logs (logins, activity), STCs (jobs, Formbay payments, the stats on one line above), Prebuilds (library, editor), Knowledge (library, add and edit), Documents (library, add), Vehicle stock (stock, purchase orders), Team (people, insurance and licences), Letter (the letter, the sign card), Purchase order (head and lines, then notes, bills and log), Supplier detail (bills, then purchase orders and activity), Meetings (list, the open meeting), Supplier bills and Price lists (the list, the open item), New job (the three cards across).
- Three columns: Bugs (new report and Open, In progress, Resolved), Ops (ask and Needs me, digest, workers and what they did).
- List pages with one table (Jobs, Quotes, Suppliers, Purchase orders, Invoices, Assets, Tools, Fleet, Incidents, DNSP, Reviews, Bill checks, Support): the stats, search and filters on one line in the head strip, the table in one column that scrolls on its own, so the filters never scroll away. Staff and Incident keep their tabs, cards two across.
- Overheads: edge to edge (the people table no longer needs its sideways scroll on most laptops), the sections stay in order because they are a form filled top to bottom.
- Done means: (1) Bugs: three lists side by side. (2) Jobs: scroll the list and the search box stays. (3) Purchase order PO2000: lines on the left, log on the right. (4) Letter: the letter and the sign box side by side.

**Left alone (clients, the public, print):** login, index, portal, pick-time, share-licences, review, rates, quote (the proposal), invoice, po (the supplier's copy), and Chat and Inbox (already on the whole screen).

**Lesson from item 76 kept:** nothing merges until someone has loaded the page with real data on the preview or staging (the owner, or a laptop chat); the cloud session cannot reach staging, so each PR's Done means is the owner's clicks on the preview link.

Touches: `public/css/style.css` (the frame, the sizes, `?v=25` on all 59 pages), `public/project.html` (classes only), then the pages named above in PRs 3 and 4 (markup and their page-top CSS, no logic), `scripts/page-budgets.json` only downwards, `docs/PROJECT_SPEC.md`, `docs/DECISIONS.md`. Overlaps: item 62 (pipeline, waiting on yes) and item 47 touch `project.html` and `dashboard.html` logic, not layout; item 74 PR 2 (client portal, to come) adds to the job Feed tab and People card; no unmerged branch or open PR touches `style.css` (checked 12 Nov 2026, only PR 34 open). Kind: feature into `staging`, four PRs; no migration; no money, stock, RLS or payroll. Size: large (two to three days; PR 1 a morning, PR 2 a day, PR 3 a day, PR 4 a morning). Test on staging: admin@staging.test, the Done means above on a laptop and once on a phone, no key needed. Simpler: nobody scrolls past tasks to read a summary, past a form to reach a list, or past a call request to reach an enquiry; what matters most on every page is on screen when it opens; no toggle or manual step added. Best model: Opus 5.5, effort high, because it is markup and CSS across many pages with no logic, money or migration.

## 84. Supplier bills with fewer taps (second pass over the whole process, 13 Nov 2026, waiting on yes)

**Owner, 13 Nov 2026:** "Check over the whole process again and make sure it's simple and look for ways it can be streamlined."

**The path as it stands (part A live, items 82 and 83 B and C on `staging`), counted from the last 30 days on production:** 15 bills came by email, 3 by upload or scan. Every one of the 15 was saved on the PO the reader suggested (8 of them were "confident": our PO number on the bill). 10 of the 18 saved bills ended up with red lines, nearly all "not on the PO" on fixed POs whose lines were typed by hand with fewer items than the supplier sent. 3 Stock items were created from bills in the month by the review screen's default. Auto-save (`supplier_bill_auto_save`) is still off: the 2-week trial from 18 Oct (item 8) was never switched on, so every confident bill still waits for a Save tap and a total prompt.

**Still by hand today, in order, and what to do about each:**
1. **Save on a confident bill (our PO number on it, supplier matched by account, ABN or bank).** 8 of 8 were right. Turn auto-save on, and let a confident **credit note** save itself the same way (the price rule decides returned or price credit; the PO page shows what it did). A person still sees it: the bill lands on the PO page, green or red, and Move / Remove undo a wrong one in a tap. Nothing changes for a guessed PO or a "New, check details" supplier: those still wait.
2. **The total prompt on every Save.** Ask only when the reader read no total, or the lines do not add up to it; otherwise the total shown on the card is the total. One tap fewer on every bill.
3. **Red lines one by one.** A bill with 10 lines not on a fixed PO takes 10 Accepts. Add **Accept all** (and **Deny all**) on the bill, next to Query supplier, and on the Bills needing a decision tab. Same database step per line, one tap.
4. **Fixed PO by default.** The Create PO panels default to "Lines known now"; the supplier then sends more than was typed and it all goes red. Keep the choice but default to **Open PO** when the panel has no lines typed (a PO raised "for the fit-off, whatever they have") and to Lines known now when lines are typed. No new toggle, the default follows what the person did.
5. **Two ways in.** An uploaded or scanned invoice goes through the review screen on the supplier page (Stock match per line, create-as-new default); an emailed one goes through the intake (one-tap save, no Stock creation). Make the upload go through the same intake: the file becomes a card (same reader, same matching, same card with the plan and the file beside it), so there is one path and one screen to learn; the review screen stays only behind Review in full. Until then: the review screen's Stock match defaults to **Not in Stock, leave it off** instead of "+ Create as new material", so junk items stop appearing (3 a month).
6. **Who hears.** The "bill needs checking" push goes to Admin and Finance only; sales staff now match bills from the PO page. Send the bills-to-match push to Sales too, naming the POs it could be for, and link it to the PO page when there is one candidate.
7. **Already paid in three places** (Emailed bills card, Bill checks, supplier page) and **Not a bill / Delete** side by side: left as they are, each has a reason.

Not changed: Close is still the approval step; Pay bills due and Record as paid stay by hand until Airwallex payouts (item 1); Xero push stays behind the three switch-on steps in item 83 part C.

**Done means:** (1) an emailed bill with our PO number on it is on the PO page within 5 minutes with nobody tapping, logged "saved automatically"; a credit note with our PO number the same. (2) Save on a guessed bill asks for no total when the reader read one that the lines add up to. (3) A bill with 4 red lines: Accept all makes them green in one tap and the bill is approved when the PO closes. (4) Create PO with no lines typed is an Open PO; with lines typed, Lines known now. (5) Upload invoice on a supplier page: the file appears as a card on the Emailed bills page with the file beside it, Save bill works the same; Review in full still opens the review screen, whose Stock match defaults to leaving the item off. (6) A sales login gets the "bill to match" push and lands on the PO page.

Touches: `netlify/functions/_shared/supplier-bill-intake.js` (auto-save for credit notes, the total rule, upload intake), `netlify/functions/supplier-bill-inbox.js` (upload action, accept_all), `netlify/functions/extract-supplier-invoice.js` or a new `upload-supplier-bill.js`, `public/js/po-bills.js` (Accept all, Deny all), `public/purchase-orders.html` (Accept all on the tab), `public/supplier-bills.html` (no total prompt), `public/supplier-detail.html` (Upload goes to the intake; review screen default), `public/js/supabase-client.js` (the PO type default in `poTypeChoiceHtml`), `public/js/po-scan.js` (scan goes through the intake too), `netlify/functions/_shared/supplier-bill-intake.js` `notifyToCheck` (Sales), `api_keys` row `supplier_bill_auto_save` = on (production, one row).
Overlaps: none (items 82 and 83 are merged; item 81 part B is on `staging` and touches the PO create panel's approve path only).
Kind: feature (into `staging`); migration no; money no (nothing approves or pays by itself that did not before), stock no, RLS no.
Size: medium (a morning for 1 to 4 and 6; 5 is another half day).

## 87. A bill line takes over the hand-typed PO line it is for (bug, found 13 Nov 2026 on PO2020, waiting on yes)

**Owner, 13 Nov 2026:** on PO2020 the guys typed "30kw inverter" as a custom line; the bill came in as "Sigen Energy Controller 30.0 kW Three Phase for AU" and was added as another line instead of editing the typed one. The invoice is what should go into Stock, so the typed line needs to be overwritten. The typed lines were ticked received, so everything is doubled.

**Found (production, read only):** PO2020 (GREENTECH, J7009) has ten lines. Five were typed on 9 Nov and received to the job on 12 Nov: the ground-mount kit (1 at $202), "Winaco 485w BDX" (38 at $160), "sigen 30kw inverter ECTP" (1 at $3,600), "9kw sigerengy battery" (6 at $2,350), the Gateway (1 at $859). Bill 103803-412 ($27,485.92 inc GST) has the same five items under the supplier's names. None paired, so all five went red as "Not on the linked PO", and Accept on each (13 Nov) added it as a new PO line. The PO now totals $49,828.20 ex GST against a bill of $24,987.20, and sits part received with five lines waiting that will never arrive. The job's cost is not doubled yet ($24,841.00, the five typed lines): it would be if the added lines were received. Nothing is paid or in Xero. No other PO has this pattern today.

**Cause:** `matchPoLine` in `netlify/functions/_shared/supplier-bill-intake.js` pairs a bill line with a PO line by part number, or by wording when three quarters of the words agree. A typed line ("sigen 30kw inverter ECTP") shares one word with the supplier's name for it, and the supplier's part numbers are on no typed line. A line that does not pair has two choices, Accept (adds a line) or Deny charge: there is no "this is that line".

**Fix:**
1. **The reader pairs what is left by quantity and price.** After part number and wording, a bill line and a PO line with nothing billed against it are paired when they have the same quantity and a unit price within 5%, and neither has a second candidate. On PO2020 that pairs all five by itself. The same rule in the upload review screen on the supplier page.
2. **A paired typed line is overwritten by the bill:** the bill's description, the Stock item when the bill's part number finds one, and the bill's price (lower or within 1%: taken; more than 1% over: red for Accept or Deny charge, as on any PO line today). The line shows "On the PO, was: sigen 30kw inverter ECTP" with Undo, which puts the typed line back. A line received before the bill came keeps its place (job, warehouse, van): only its name and cost change, and the job's cost follows.
3. **Same as... on a red line** (beside Accept and Deny charge) when the PO still has lines with nothing billed: pick the line and it is taken over the same way. For the cases the rule cannot decide (two typed lines with the same quantity and price, or a price far from the typed one).
4. **PO2020 repaired** with the fix, in one transaction kept in `scripts/datafixes/`: the five Accepts undone (the added lines come off; nothing was received on them), each bill line paired with its typed line. PO2020 ends with five lines named as on the invoice, received to J7009, $24,987.20 ex GST, ready to close; J7009's materials go from $24,841.00 to $24,987.20 (panels $160.00 to $164.90, inverter $3,600 to $3,560).

**Done means:** (1) A PO with a typed line "30kw inverter", 1 at $3,600; a bill for "Sigen Energy Controller 30.0 kW", 1 at $3,560, saved on it: the PO still has one line, now named as on the bill at $3,560, and the bill line is green. (2) The typed line was ticked received first: still one line, received, the job's cost $3,560. (3) Two typed lines with the same quantity and price: the bill line is red with Same as..., and picking one takes it over. (4) Undo on a paired line puts the typed name and price back and the bill line is red again. (5) PO2020 shows five lines, total $24,987.20, bill 103803-412 with no red lines.

Touches: `netlify/functions/_shared/supplier-bill-intake.js` (`matchPoLine`, the save loop, the card's plan), `public/js/po-bills.js` (Same as..., the "was" label, Undo), `public/supplier-detail.html` (the review screen's match), `netlify/functions/supplier-bill-inbox.js` if the action passes through it, one migration (`supplier_bill_line_items.po_line_before jsonb`; `supplier_bill_line_resolve` gains match and its undo; an inner function the reader calls), `scripts/datafixes/` (PO2020), `docs/PROJECT_SPEC.md` A11a, `docs/DECISIONS.md`. Overlaps: item 84 (waiting on yes, not started) lists `supplier-bill-intake.js` and `po-bills.js` for other functions (auto-save, Accept all): build it after this one in the same chat if it gets its yes. No unmerged branch or open PR touches these files (PR 34 is the old email workers branch). Kind: bug fix into `main`; migration yes (SQL shown before production); money yes (PO line and job costs) and stock yes (what a received line is called and costs), so a backup before the production migration; RLS no new table (one security definer function, pricing roles); payroll no. Size: medium (a morning). Test on staging: sales@staging.test, a PO with typed lines, a bill saved on it from Emailed bills (or Upload invoice on the supplier page), the five Done means; no key needed unless the bill is read by AI from a file (the AI key on staging). Simpler: nobody has to notice that the bill's line is the typed line, delete a double, or fix a doubled PO; Same as... is one tap, only when two typed lines look alike, because the system cannot know which is which. Best model: Fable 5.2 (this chat), effort xhigh, because it is a migration that moves cost and stock figures plus code in one go.

