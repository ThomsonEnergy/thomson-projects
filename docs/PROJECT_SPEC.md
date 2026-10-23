# TEops (Thomson Projects): Build Spec

Last verified against code: 17 Oct 2026

Internal operations app for Thomson Energy Australia (electrical and solar contractor). Live at projects.thomsonenergy.com.au, with thomsonprojects.netlify.app kept as a working backup. The code is the source of truth: if this file and the code disagree, fix this file.

**Stack:** Netlify (Git-connected deploys, serverless and scheduled functions) · Supabase (Postgres, auth, storage) · Xero (Accounting API + Payroll AU API, **live**, real company) · Anthropic API (AI extraction, generation, assistant) · AssemblyAI (meeting transcription) · Airwallex (client payment links) · Gmail API (shared sales@ inbox, **live**) · Web Push (phone notifications, **live**) · Pylon (solar design, pull and push) · Formbay (STCs, webhook receiver only so far) · ABR (ABN lookup).

**Credentials:** integration keys live in the Supabase `api_keys` table, edited in Settings > API Keys, and are read server-side with `getIntegrationKey()` (`netlify/functions/_shared/get-integration-key.js`; it falls back to a `<NAME>_API_KEY` env var only if no row exists). Keys in use: anthropic, assemblyai, abr_guid, airwallex_client_id / api_key / webhook_secret, xero_client_id / client_secret / webhook_key, google_client_id / client_secret / refresh_token, pylon, formbay, formbay_webhook_secret, vapid_public_key / private_key, servicem8 (import only). Only platform secrets stay as Netlify env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEV_MODE_PASSWORD`, `GITHUB_TOKEN` (bugs sync), `CLAUDE_AGENT_KEY` (agent comments), `PDF_KEEP_BROWSER` (optional).

**Deployment:** edit in the local GitHub clone, commit and push, Netlify auto-deploys. **Run Supabase migrations before or alongside the deploy.** Bump the `?v=` on any edited JS/CSS (10 minute cache). Latest migration: 155 in the old `Migrations/` numbering; new ones live in `supabase/migrations/` (latest 20261018120000).

**Ordering:** Roadmap and Part 0 (priorities) first, Part A is everything live, later parts are what is still missing.

---

## Roadmap

- **Ideas and new features:** `docs/IDEAS_BACKLOG.md` (reconciliation and receipts, voice messages, native iPhone app, weather scheduling, per-user inboxes, policy sign-off and location, SMS and calls).
- **AI agents:** `docs/AI_AGENTS_PLAN.md` (ops manager agent, workers, team chat).
- **High lead time, start now (external, weeks of waiting):**
  Live status: `docs/EXTERNAL_ACCOUNTS.md`.
  1. **Apple Developer organisation account:** D-U-N-S 17 Oct 2026, enrolment submitted 17 Oct, Apple verifying. Blocks the native iPhone app, and so SMS and calls. TEgo app stage 1 is built and waiting on this: `docs/IOS_APP.md`.
  2. **Port 0455 415 464 from Telstra to our own Twilio account:** Twilio bundle approved 18 Oct 2026, test number 0468 085 277 active. Port after SMS and calls are built and tested. Today SM8 only uses the number as a Twilio verified caller ID.
  3. **NSW Workplace Surveillance notice:** adviser review of the notice and policy, then 14 days' written notice before any AI reading of chat/email/voice or location tracking starts.

---

## PART 0: Go-live priorities

**Aim: the whole company working in the app from day one.** Anything not on the day-one list must not block starting.

### Day-one checklist
Manual steps only a person can do (the code is live):
1. **Supabase > Authentication > URL Configuration:** Site URL `https://projects.thomsonenergy.com.au`, and add `https://projects.thomsonenergy.com.au/**` to Redirect URLs (keep the old one). Until done, invite and password-reset emails link to the old address.
2. **Google Cloud:** add redirect URI `https://projects.thomsonenergy.com.au/.netlify/functions/google-oauth-callback` (keep the old one); add the new site to the Maps key restrictions if it has any.
3. **Airwallex, Xero and Formbay dashboards:** webhook URLs point at `https://projects.thomsonenergy.com.au/.netlify/functions/airwallex-webhook`, `.../xero-webhook` and `.../formbay-webhook`.
4. **Settings:** check Company Details, Payment details (in Payment Terms & T&Cs), the Google review link and Billable Rates (they print on every quote, invoice and estimate).
5. **Everyone:** log in once on the new address, re-add the app to the phone home screen, press "Enable phone notifications".
6. **One full dry run with a real job:** quote, email it, accept and sign from the link, check the job lands at quote_approved, pay the deposit, check it moves to Awaiting Our Action or Ready to Book, schedule, clock in and out (slider), invoice, push to Xero, pay, check PAID. Fix anything that breaks before anyone depends on it.
7. **Bookkeeper:** confirm the Employment Hero to Xero payroll cutover (H2), and push each employee's pay rates (Settings > Users & Roles) before the first real pay run.
8. **ServiceM8 cutover:** re-run the SM8 import (Settings > ServiceM8 Import) on cutover day, then the attachment copy.

### Order of importance

**Tier 1: must work on day one.** All built; the work is the live walkthrough (item 6) and fixing what it finds.
1. Logins, roles, permissions, Log out everywhere (A14, B2, B3).
2. Clock in/out, cost-centre slider, timesheets (A1).
3. Quotes: build, send, client signs, job created (A3, A6, A22).
4. Job page, Schedule, My Day (A13, A17, A19).
5. Invoicing and getting paid: Xero push, card payment, PAID stamp (C, H3, A22).
6. Purchase orders and stock basics (A10, A12).
7. Notifications and the shared sales@ inbox (A18, A20).

**Tier 2: first 2 to 4 weeks**
1. Timesheet and leave approval by each person's manager; Finance and above approve all (M1).
2. Archive or delete duplicate signed documents per employee (M2).
3. Credit notes: test on a real Xero invoice (built, never tested live).
4. Client cards: one hub per client (E1).
5. Reactive jobs: formalise Direct Job into a proper small-jobs flow (Part F).
6. Field forms: SWMS, Take 5, inspection forms with PDFs (G1). Move to Tier 1 if digital safety paperwork is needed on day one.
7. Materials list export per cost centre (E3).
8. Clean-up: categorise the 67 "Needs Review" materials; link prebuild materials to the Materials Database (A9a).
9. Part I gaps: deposit vs pay in full on acceptance, auto PO suggestions, auto Ready to Book when POs received.

**Tier 3: growth**
1. Gantt-style job windows driving scheduling and ordering (M3).
2. Xero Division tracking category on invoices, credit notes and job bills (H5).
3. Formbay phases 2 to 4: process webhook events, post settlements to Xero, create Formbay jobs (Part L).
4. Job page charts and flags (Part J).
5. Stay logged in and Face ID login (B4).
6. Offline support (G2), only if poor signal proves a real problem.
7. SMS and calling (G3), after the native iPhone app.
8. In-app solar pricing tool (Part K).

**Tier 4: AI helpers and automation (deliberately last)**
1. AI prebuild creation (D3).
2. Plan-reading takeoff and wholesaler quote loop (D4).
3. Assistant (Sparky) upgrades and the agents in `docs/AI_AGENTS_PLAN.md`.
4. Supplier bills to Xero as Bills, and Airwallex supplier payouts (moves real money, test first).

**Tier 5: security sweep (last, once major additions stop)**
1. Full security sweep and hardening: re-enter password on admin pages, idle lock, two-factor for Admin and Finance, leaked password protection, RLS and function checks, key rotation, 2FA on outside accounts. Detail: `docs/IDEAS_BACKLOG.md` item 15.

---

## PART A: Built and live

### A1. Time tracking and payroll
- Clock in / clock out overlays appear on the tap with Loading..., and show an error card with Close if the load fails (UX 1). A job with one stage is preselected on My Day (UX 6). Break start defaults to 12:00 (or mid shift) when a break is asked (UX 16). Home has a Switch job button (UX 7). Timesheets has a This week button (UX 18).
- Clock in/out against job and stage from My Day; manual entries; leave requests with approval; staff scheduling calendar.
- **My Day task cards** (Your scheduled tasks, Free tasks up for grabs): main tasks only (subtasks counted as "3 of 5 subtasks done", not listed; a subtask of yours still shows when its main task is not yours), split Prejob / office, Handover, Onsite with counts, grouped by job (required first, then oldest), 10 jobs per group then "Show all", search on free tasks. A task with open subtasks shows "Open job" instead of Done.
- **Clock-out cost-centre slider** (`cko-split-slider` in `public/js/supabase-client.js`): split the shift's hours across stages at clock-out, waterfall redistribution. Closed variations drop out of the list; do-and-charge variations can take time.
- **Who's clocked in:** "Clocked in now" card on Schedule and Team, "On this job now" with clock in/out/switch on a job's Summary (migration 147, `get_active_clock_ins`).
- **Schedule month view (21 Oct 2026, backlog item 28):** equal-width day columns, fixed cell height (120px, 80px on phone) with the chip list scrolling inside the cell and a fade at the bottom while more is below, a booking count next to the day number, one chip per job per day with the first names on it (leave stays per person; no-job blocks show Inspection, Site visit, Training, Admin or Other). Bookings only: a time entry never creates a booking, so a timesheet added later with no booking does not show on the schedule. `public/schedule.html` only, no migration.
- No overlapping entries; at least one cost centre per entry; break prompt on every entry.
- Timesheet categories: Billable (Jobs), Quoting, Admin, Maintenance, TAFE, Training (migration 134). One-click TAFE day (8 paid hours as Training, 30 minute unpaid break).
- **Admin/Finance timesheet dashboard:** everyone's timesheets, editable, flags any day over 6 hours with no break.
- **LAHA:** a job over ~100 km from base can be flagged "LAHA approved"; clock-out asks about an overnight stay; confirmed nights push as a separate LAHA earnings line (once per day per project).
- **Xero Payroll push (live):** timesheets push on demand, split by the Work Type tracking category (not per job: Xero caps a category at 100 options). Ordinary, OT1, OT2 and Public Holiday bands each map to a **Jobs** and an **Office** earnings rate (migration 151). Public holidays pay base plus penalty (migration 152).
- **Pay rates to Xero:** each employee's 4 contract rates (set in the app) push into their Xero pay template (`push-pay-rates-to-xero.js`, migration 150); Settings > Users & Roles flags anyone whose rates changed but were not pushed.
- **Link employees to Xero:** `link-employee-to-xero.js` links to the existing Xero employee record instead of creating one.
- Pay templates and payroll calendars stay in Xero. TFN, super and bank details are collected by Xero's own onboarding, never by the app.

### A2. Numbering
- Quotes Q1000+, Jobs J7000+, Invoices SI3000+, Purchase Orders PO2000+, Progress claims PC2000+ (one global counter).
- Cost centre numbers are job#-position. All counters are atomic Postgres functions, editable in Settings > Numbering, with no Xero dependency.

### A3. Quotes and job types
- Templates (`proposal_template`): **new_build** (multi-stage, deposit 10% default, AI scope of works, T&Cs), **solar** (Pylon design data on the cover, solar questions, "Batteries as well" tick adds the battery set and rules, solar task generation), **battery** (migration 20261115000000: battery questions, battery cover photo and "Your system" page, battery rules and tasks), **renovation**, **service_work**, **quick_estimate** (single cost centre, no deposit, signed, invoiced from actuals, Schedule of Rates page, migration 140).
- **Gather first, generate last (21 Oct 2026, backlog item 24):** the new quote page and the quote edit tab run in order: type, Pre-quote information card (where it came from, when, who; then the type's questions: solar, battery, renovation, service work; `public/js/template-questions.js`, answers on `projects.template_answers`, editable any time, a completed site inspection for the quote or its lead linked from the card), client and site, Pylon, stages and pricing, then "What the customer gets" (built from the answers, the Pylon equipment and the stages) and the AI scope of works, which gets the answers, the customer summary and the type (`generate-scope.js`, `generate-sow.js`, battery wording for backup, location, VPP, discount, AS/NZS 5139). The brief is saved (`projects.sow_brief`). A draft saves with a name and client only; no PDF until a stage is priced. **Ex GST:** every stage says all amounts are ex GST with GST added once on the Investment summary. **STCs:** the STC block and the default $ per STC and zone show only on Solar and Battery proposals (an older stage with a total keeps showing it); "Number of STCs" (`cost_centres.stc_quantity`) can be typed instead of the system size, a typed count wins, and the job's STCs tab offers it. **Ready to send gate:** `check-solar-compliance.js` (phase quote) checks every quote type: required answers, a priced stage, terms, then the solar rules and the battery rules (`_shared/solar-compliance-rules.js`, from `docs/SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md` and `docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md`); "Email quote to client" and the Pipeline board's move to Quote Sent run it (`quoteSendGate`), Admin and Finance may send anyway with a reason (`projects.send_gate_override_reason`, activity log). Battery jobs (and Solar with Batteries) get battery pre-job and handover tasks on approval (`_shared/template-job-tasks.js`). **New prebuild from a quote:** the stage picker's "+ New prebuild" opens the shared form (`public/js/prebuild-form.js`, also the Prebuilds page), saves to the library and adds it to the stage.
- **Quote in steps (21 Oct 2026, backlog item 27, migration 20261117000000):** `new-project.html` is now only Create: proposal type, project name, client (search or new), site, payment terms, notes; Create quote draws the Q number, saves the draft with the template's deposit and milestones and opens the quote at `project.html?tab=quote`. A quote that is not yet approved has a **Quote** tab, open by default, with five cards each with its own Save: 1 Pre-quote information (the question card, proposal type can be changed, site inspection linked), 2 Site visit (needs a visit with Schedule inspection, or not needed with a reason; `projects.site_visit_decision`, `site_visit_reason`), 3 Pricing (Pylon, stages and line items through the shared editor, Suggest prebuilds with AI, the STC and BSTC credits, deposit, breakdown tick, milestones, estimate wording), 4 Scope of works (what the customer gets, brief, documents, Generate, the text, subtitle, reference photos, terms), 5 Send (ready-to-send check, documents to gather, quote link, Make PDF, Email quote to client). Ticks on the step bar show what is done. "Edit quote" (the full editor) stays as a fallback. **STC and BSTC credits sit on the quote** (`projects.stc_quantity/stc_system_kw/stc_zone_rating/stc_install_year/stc_price_per_certificate/stc_total`, `bstc_quantity/bstc_price_per_certificate/bstc_total`, `bstc_not_claimed`, and `stc_cost_centre_id` / `bstc_cost_centre_id` for the stage each is claimed with, blank meaning the last stage); the migration copied every stage's credit up to its quote, the stage columns stay for history and only show on a stage that still carries one. The proposal shows STC credit and BSTC credit as two lines (`get_quote_by_token` returns the quote-level figures). **Invoices:** the credit remaining is the quote's figure less every claim of that kind on the job (`quoteCreditSummary`), offered on the claim for its stage once that stage is fully claimed; `invoice_claims.bstc_amount`, `invoices.bstc_amount`, `credit_note_claims.bstc_amount`; `get_invoice_balance_due` and the paid maths include both; the invoice page and `get_invoice_by_token_v3` show BSTC on its own line; Xero gets "STC Credit" and "BSTC Credit" as two lines on the one STC mapping (same chart of accounts code); credit notes reverse each kind. `create-job-from-quote.js` carries the quote-level figures to the job and re-points the claim stages. The STCs tab offers a PV row from the STC count and a battery row from the BSTC count. The ready-to-send rules read the quote-level figures (STC count or size plus total on Solar; BSTC count plus total, or the "no BSTC" tick, when the quote has a battery).
- **Electricity bill reader and savings page (22 Oct 2026, backlog item 29, migration 20261118000000):** step 1 of a Solar or Battery quote has an Electricity bill card: every page (phone photos or the retailer's PDF) is filed privately as `project_documents` in the "Electricity bill" folder (`project-documents/bills/<quote id>/`, also on the Documents tab); "Read bill with AI" (`read-electricity-bill.js`, pricing roles) sends every page in one call and saves the reading on `projects.bill_reading` (retailer, network, NMI, period, kWh, time-of-use split, controlled load, solar export, rates, supply charge, bill total, phases, notes, who and when) with the sizing worked out in code (`public/js/solar-roi.js`: solar kW from daily use and the STC zone yield less existing solar, battery kWh from the evening share, rounded to common sizes within the 5 to 100 kWh discount band), fills blank answers (NMI, daily use, supply, network, existing solar) and logs the run. Buttons put the suggested sizes on step 3 (system size) and step 1 (usable kWh wanted). The card shows a savings preview that follows the pricing and the answers. **Proposal:** Solar and Battery proposals get a "Your savings" page (after Your system) when the quote has a bill reading and the step 3 tick "Show the savings estimate on the proposal" (`projects.show_roi`, on by default) is on: use and bills now, generation, stored, used at home, exported, grid after, bills after, saving a year, investment after credits, payback, yearly return, 10 and 25 year savings, emissions, assumptions note; `get_quote_by_token` returns `bill_reading`, `stc_system_kw`, `stc_zone_rating`, `show_roi` and `roi_answers` (the six answers the maths needs, never the whole set). **What we quote drives it (migration 20261119000000):** the estimate uses the STC system size, `projects.battery_kwh` (battery quoted, usable kWh, on step 3) and the total after credits; the bill's own sizes are shown as a recommendation with Quote this size buttons. **Charts:** `roiChartsHtml()` draws three inline SVG pictures on the Your savings page and the preview (yearly bill now and after, where the power will come from, savings adding up against the investment with the paid-off year). **Missing information:** `roiGaps()` lists what is missing and `roiPresentation()` what shows: a red box on the bill card for the staff; the proposal still goes out and shows only the rows we can stand behind (no rates or total: kWh rows only; no existing solar size: use and bills now only; no bill: none), then "To give you Y, we need X" per item and that accepting before then is accepting on what is shown; office-only gaps (size, price) just drop their rows; warnings (short bill, no supply charge, no time-of-use split) keep the figures with the assumption declared. Sending is never blocked. **Also:** step 5 checklist items take several files (`quote_compliance_answers.photo_paths`, `photo_path` stays as the first) with Clear files, and the Electricity bill item counts as done when step 1 has pages; step 4 supporting documents are saved on `projects.sow_documents` and the bill pages go to the scope of works AI too (`generate-sow.js`, up to 12 files).
- **AI guesses the parts (21 Oct 2026, backlog item 25, migration 20261116000000):** on the prebuild form, "Suggest components with AI" (`suggest-prebuild-components.js`, pricing roles) guesses the labour and material components from the name and description, matched to Stock (a known part comes with its Stock cost, an unknown one has no cost and says Needs a price); rows arrive tagged "AI suggested, check" and the form will not save while a tag is left (Confirm, edit or remove). On the quote pages, "Suggest prebuilds with AI" under the stages (`suggest-stage-prebuilds.js`, pricing roles) reads the scope of works, the pre-quote answers and the stage names, picks prebuilds from the library only, and adds each to its stage through the normal prebuild path tagged "AI added, check" with the reason and a Confirm button; the tag is saved as `cost_centre_line_items.ai_suggested` and the ready-to-send gate lists any left. Every run is written to the quote's activity log (shown on the Logs page). Prices are never invented.
- **Direct Job** (`direct_job`): "+ New job (no quote)", goes straight to a job, invoiced from actuals with do-and-charge lines (A22). `time_and_materials` is the legacy equivalent.
- Client signs the quote on screen to accept it (migration 144). "Prepared by" on the cover and investment page (migration 140).
- **Variations:** fixed-price (quoted, emailed, signed by the client, added to the job; migration 143) and do-and-charge (log hours, add Stock and prebuilds, each becomes its own stage and is claimed like any other; migration 142). Signed variations remake the quote PDFs and file the old one as legacy. A fixed-price variation is its own document in the proposal look (`quote.html?variation=`: cover "Variation No. N to Quote Q / J", the original quote's number, date and link, what and why, price, contract summary, sign block); it no longer repeats the whole quote. "Email to client..." makes its PDF and sends it attached from sales@ through the app (Emails tab), with the sign online button; cards have View PDF / Make PDF. Fixed-price lines can be typed or added with "+ From Stock or prebuild" (Stock at cost x (1 + default markup); a prebuild adds a labour line at its own rates and a materials line marked up); price only, nothing leaves Stock. **Approve and decline:** quotes and fixed-price variations can be marked approved by email (the client's email tagged to the job or quote is picked and linked as proof), phone call or in person (note required); a variation then becomes a stage exactly as when signed (`_shared/approve-variation.js`, `approval-actions.js`; quotes via `manually-approve-quote.js`). Decline: the client has a Decline button (optional reason) on the quote and variation pages (`decline-by-client.js`, creator notified); staff Mark declined with a reason and optional email. Declined quotes sit in the Quotes page's Declined tab, declined variations never reach an invoice; both can be reopened (quote to Sent, variation to Draft). Migration 20261029000000. **Valid until and expiry:** a quote (when it moves to Quote Sent, which now also sets its status to Sent) and a fixed-price variation (when sent) get a valid until date: today + Settings > Company "valid for (days)" (default 30), shown to the client. `sweep-quote-expiry.js` just after midnight Sydney: reminder to the creator 3 days before, then anything still sent past its date is declined as Expired (creator told, ops page "Quote and variation expiry (nightly)"), unless Settings "Auto decline expired" is off or the quote / variation has "Don't auto decline this one". Extend... (Sales, Admin, Finance; +7 / +14 / +30 or a date, optional email to the client with a fresh PDF) also reopens an expired one; Reopen of a client decline gives a fresh date. Migration 20261030000000. Drafts load too so the PDF can be made before sending (migration 20261028000000); signing still needs it sent. Details tab "Email quote to client" makes a fresh quote PDF and opens the in-app email (no more Gmail link), marking the quote Sent once it goes.

### A4. Photo library
- Tagged electrical / solar / general; templates surface the relevant category. Every upload goes through `compressImage()`.

### A5. Look and feel
- Phone and readability pass (UX delivery 3, 20 Oct 2026): 44px top bar icons on touch screens with Log out in the menu behind "Log out of TEops?"; every button at least 40px tall on touch screens; all popups go through `openModal` (card scrolls inside itself); muted text, dark theme primary buttons and status badges pass contrast on both themes (`.badge.amber / .green / .red / .info`); pin star visible; text floor 12 to 14px (`.small`, `.tiny`); chat times 12px. Shared feedback: `showToast(message, { error })` for Saved / Sent, `friendlyError(err)` turns network errors into "No signal. Try again when you have reception.", and a red No signal pill on every page when offline (UX 50, 51, 53).
- TEops wordmark, animated wiring background on login and home. Themes Navy Pro and Dark Trade (per user, saved to Supabase; dark by default on touch devices). No sideways page scroll; global search.

### A6. Job pipeline (14 stages, migration 112)
- lead, draft_quote, quote_sent, quote_approved, deposit_paid, awaiting_action (shown as Awaiting Our Action: we need to do something), awaiting_client_action (Awaiting Client Action: the client needs to do something; moved by hand on the board, no automation moves a job in or out, migration 20261112000000), ready_to_book, job_booked, job_not_complete, client_handover, ready_to_invoice, awaiting_payment, complete, archived. Board is `dashboard.html` ("Job pipeline").
- **Pipeline automation Phase 1:** accepting a quote runs `create-job-from-quote.js`, which creates the job at **quote_approved** and raises the deposit invoice (`is_deposit`). When the deposit is paid, the Airwallex and Xero webhooks move it on (`_shared/advance-job-stage.js`): to **awaiting_action** if any required-before-scheduling task is open, otherwise **ready_to_book**. No deposit needed: it moves on straight away. Later payments check for **complete**.
- `archive-completed-jobs.js` (daily) moves jobs at complete for more than 2 days to archived.
- Manual only: draft_quote, job_not_complete and Not Complete back to Booked.
- **Job Booked gate (migration 20261023000000):** a job is only **job_booked** while someone is scheduled to it (a job booking today or later) or clocked into it now. A booking or clock-in moves Ready to Book to Job Booked; removing or moving the last booking moves it back (to Awaiting Our Action if required tasks are open); clocking out does not (the clock-out "How's the job?" step decides). Quick Job, Warranty Job and ServiceM8 imports start at Ready to Book. Moving a job to Job Booked by hand with nobody scheduled or clocked in is refused. `sweep-job-booked.js` (just after midnight Sydney, migration 20261024000000) moves back any job whose last booking has passed with nobody clocked in.
- **Clock-out "How's the job?" (UX 12, 22):** "Not complete, back <day>" books the next working day through `book_back_after_clockout` (migration 20261106000000, so Staff-role tradies can book themselves back; caller only, a job they clocked out of in the last 18 hours, next 7 days, skipped if already booked) (Saturday and Sunday roll to Monday, public holidays are not rolled); the double-booking warning waits for Continue; "Not finished, do not book me" sets job_not_complete with no booking for the PM to schedule. Complete on a job with no CCEW offers an optional "Take photo of the CCEW" on the last step (saved to the same place as the CCEW card).

### A7. Navigation
- **Grouped menu (UX delivery 4, 20 Oct 2026):** Pipeline is a top bar icon. `MAIN_NAV_ITEMS` entries carry a `group` (sales, purchases, team, office); laptop shows starred pages plus Sales / Purchases / Team / Office dropdowns, the phone menu lists Home, Schedule and starred pages then the four groups (one open at a time, remembered on the device), every page with its icon, Log out last. Sales: Leads, Quotes, Jobs, Invoices, Clients, Reviews, Inbox, STCs, Customer equipment. Purchases: Purchase Orders, Stock, Vehicles, Suppliers, Tech Support, Emailed bills, Bill checks, Price lists, Prebuilds. Team: My Day, Schedule, Tasks, Timesheets, Chat, Meetings, Knowledge, Documents, Incidents, Team. Office: Overheads, Ops manager, Updates and ideas, DNSP, Logs, Settings. Leads and Clients are pricing roles only. Staff who never edited Home tiles get field tiles. Tab titles via `setPageTitle(text)` ("<record> - TEops", kept next to the unread count). One profile read per page via `getMyProfile()`.
- One list, `MAIN_NAV_ITEMS` in `public/js/supabase-client.js`, rendered by `renderMainNav()`. On a computer the top bar shows starred pages (also the Home tiles) plus the current page, the rest under "More"; the phone menu lists everything. Schedule, Settings and notifications are top bar icons.
- Items: My Day · Inbox · Leads · Quotes · Projects · Job pipeline · Invoices · STCs (pricing roles) · Purchase Orders · Tasks · Meetings · Suppliers · Timesheets · Clients · Reviews · Assets · Stock · Prebuilds (pricing roles) · Overheads (finance) · Knowledge · Tech Support · Team · Incidents (finance) · DNSP · Fleet · Bugs & Updates · Logs (admin).

### A8. Icons
- "TE" favicon and home screen icon, PWA manifest.

### A9. Prebuilds
- Name, internal part number, client description, category, bundle of labour (hours x rate tier) and material lines; scales with quantity; client sees description and total only.
- Xero coding per line type via `xero_account_mapping` (C4).
- 55 prebuilds imported from the SM8 bundle catalog (7 Sep 2026). Material lines are **not yet linked** to the Materials Database (A9a).

### A9a. Materials Database
- `materials` table (category, supplier, cost, sell, stock on hand), filled by AI price list extraction (`extract-pricelist.js`). 174 imported; 67 still tagged `Other / Needs Review`.

### A10. Purchase orders
- **Simpler purchase orders (23 Oct 2026, backlog item 31, no migration).** `purchase-orders.html` is one short row per PO (number, supplier, where it is going, "3 of 8 received", total, status chip, red "Bill needs a decision"), open POs loaded first (lines and bill states only, no bill lines), Closed loaded on the Closed tab (last 300). Tabs Open / Waiting on delivery / Ready to close / Bills needing a decision (pricing roles) / Closed, three tappable count tiles with the same words, open POs sorted needs-a-decision, ready to close, part received, ordered. An old `?id=` link goes to the PO page. **One PO, one page** (`purchase-order.html?id=`, the top bar search and every list link to it): header with status, supplier, destination link, total; one **next step** button that changes with the state (`poNextStep`: decide on a bill line in red, close and approve, add the lines or upload the invoice on an open PO, email it to the supplier if never emailed (activity log `emailed`), receive what arrived); **tick to receive** (`renderPoTickLines` / `wirePoTickLines`: tick the lines that arrived, Tick all, one "Receive N to J7040 / Stock / the van / the Tools register" button, destination preset from the PO, one `po_receive_line` call per line; "somewhere else" and a "..." sheet per line for back order, move, undo received, add to Stock, mark as a tool); **More** sheet for add an item, edit lines, email, PDF, notes, prices on the PO, upload invoice, close, reopen, log; bills folded unless a line needs a decision; log folded. The job page Purchase orders tab, the Stock page, each vehicle page and the supplier page show the same short rows (open POs on Stock and vehicle pages). **Create PO panels** (Purchase Orders, job, Stock, vehicle): what it is for, supplier, lines; stage, description, open PO, budget cap, notes, prices, attach a document and upload-the-invoice-instead sit under **More options**; after Create a panel says "PO1234 created for Supplier" with **Email it to the supplier now** and **Open the PO**. **Show me how** (`startGuidedTour`, `offerGuidedTour`): a guided tour on the Purchase Orders page (tiles, tabs, search, a row, Create, then the Create panel field by field) and the PO page (status, next step, tick boxes, Receive, the "..." on a line, More, bills, where it is going) that spotlights the real buttons with a short card; offered once to anyone new (localStorage `te-tour-po-list`, `te-tour-po-page`) and on the Show me how button any time. The old per-line Receive / Move / Backorder buttons and the per-PO button row (`renderPoLineItemsReceivable`, `renderPoControls`) are gone.
- UX delivery 3: Receive all on an open job PO (one `po_receive_line` call per line, server side); PO suggestions on a job show a tick box per stock line with the Warehouse count and take stock off through `po_create_stock_pull` per stage (a closed Stock PO per stage); Create PO requires a supplier except for stock pulls, a blank unit cost blocks the save ("Enter 0 if it is free"), changing Where from no longer wipes typed lines, PO rows fit a phone (UX 36, 47, 71, 72, 73, 80).
- `purchase-orders.html`: every PO for a job, Stock or a vehicle (vehicle PO with no supplier = pulled from the Warehouse). Searchable material picker; generic-to-specific line reconciliation; invoice upload straight onto a PO; PO-number auto-matching. One shared supplier search-or-create picker on every PO surface.
- **Status, kept by the database** (migration 20261108000000): Ordered, Part received, All received, Closed (`purchase_orders.status`, with `received` following the lines on every line change, trigger). One badge everywhere. Purchase Orders page: "Ready to close" = open POs with every line in.
- **Close is the approval step** (migration 20261108000000, replaces "approved when fully received"): a PO closes only when every line is received, back ordered or moved off; with back ordered lines the closer picks **Wait** or **Close now, cancel the back orders** (lines removed, logged). Closing approves the PO and its bills that match it or were accepted (never for a "New, check details" supplier) and sets their pay-on date. When the last line is received the PO shows a green **All received: close and approve** button. Nothing is received or moved on a closed PO. **Reopen**: Admin/Finance, note required, its unpaid bills are no longer approved. **Undo received on a closed PO** reopens it the same way (Admin/Finance, note). Optional budget cap.
- **Bills on the PO** (migration 20261109000000): the PO page (`purchase-order.html`, Bills fold) lists its bills with their lines: green = on the PO, **red** = not on the PO, charged more than the PO, a freight / delivery / handling charge (always red, even on an open PO, so we always see we were charged) or denied. Pricing roles decide each red line: **Accept** (not on the PO: the line is added to the PO and linked; freight, or any line on a closed PO, is received straight to the PO's own destination so it is costed; otherwise it waits for Receive. Charged more: the PO line and the job's cost rows take the billed price) or **Deny charge** (reason; the bill is no longer approved and the please-explain email opens, written by the server with the denied charges first, sent from invoice@ only on Send). Undo on an Accept or Deny. Bill chip: Approved with pay-on, Queried, Needs a decision, Accepted, Approved at close, Paid. `supplier_bill_line_items.resolution` accepted / denied / added. Bill checks treats a denied line as a problem until it is undone.
- **Fixed or open PO** (migration 20261109000000): every Create PO panel asks (under More options) **Lines known now** (the invoice is matched to them) or **Open PO: lines filled in from the supplier's invoice** (`po_type` open, badge on the PO). When a bill is saved against an open PO (review screen or the emailed one-tap save) its lines that are not on the PO are added to the PO, linked and received the normal way; a fixed PO only matches and flags. Freight is never added.
- **Who can change what** (migration 20261108000000): everyone reads, creates and edits a PO's notes, description and prices toggle; the money, job, supplier and state (amount, cap, closed, approved, received, status, number) are pricing roles only (database trigger); only pricing roles delete a PO; a received line cannot be deleted (Undo received first).
- **Stock PO on a job** (`po_create_stock_pull`): job page Create PO (and the Purchase Orders page for a job) has **Where from**: a supplier, Warehouse stock, or a stock vehicle. Stock lines show the app's count there and **Left after you take it**; taking more than the app has needs that box, and whatever is typed becomes the real count (logged on the material: "Warehouse count corrected on PO 2101: app had 0, actually 3 (took 1, 2 left)"). The PO (supplier name Warehouse or the vehicle) is made Closed and received, costed to the job at material cost (`job_material_usage` from_stock). No follow-up task, bill or email. Works for every role.
- **Receiving**: per line to the Warehouse, a vehicle, or (on a job PO) only its own job. A PO with no job can be received to a job (done as a Move). All server steps (`po_receive_line`), so staff can receive too.
- **Move** (`po_move_line`): any line, received or not, all or part (part splits the line), to another job (with stage), the Warehouse or a vehicle. Comes off where it was first; refused if that job already invoiced it or the stock is no longer there. Logged on the PO and both jobs. A job's PO list also shows other POs with a line moved onto it; job material cost counts lines received to the job, whichever PO they are on.
- **Undo received** (`po_undo_receive`): reverses the receive (off the job, out of the stock count; a stock PO's gear goes back where it came from). Option "It's back ordered" with ETA. Note required once the PO is closed or a bill on it is approved for payment.
- **Email PO**: `po.html` (invoice layout: letterhead, supplier, job number and delivery address, lines ex GST, GST, total; no payment parts), PDF via `generate-client-document-pdf` type `po`, opened in the normal email window to the supplier's contact email with the PDF attached. **View PO** opens the page.
- **Notes** (migration 20261026000000): every PO has "Notes for supplier" (printed on `po.html` and the PDF) and "Internal notes" (staff only), set when creating the PO or later with **+ Notes / Edit notes**, editable even when closed, changes logged on the PO.
- **Prices on the PO** (migration 20261027000000): off by default, so the supplier's PO page and PDF show items and quantities only (the server does not send prices). **Prices on PO: Off / On** button on each PO, and a tick box on the Create PO panels. Staff still see prices in the app.
- **Every PO has a number**: a PO saved without one draws the next (database rule). The blank one from bill M61732 (J7002 page) became PO2001; the supplier page's "Create a PO from this bill" now draws one too.
- **+ Add to Stock** (`po_line_add_to_stock`, Admin/Finance/Sales): on any PO line not linked to Stock. Filled in from the line (name, PO supplier, cost, sell = cost + default markup), links the line, and adds the quantity to the Warehouse or vehicle count if it was already received there. Logged on the PO and the new item.
- "Generate PO suggestions from quote" button on the job page (manual).
- **Stock counts** (migration 20261108000000): every count change by hand goes through `stock_set_count` (locked, logged on the item as "Warehouse count set to 5 (app had 3): stocktake" with who). Stock page edit panel has a Warehouse and a per-vehicle count with a reason box; a vehicle page count is tapped to correct it. Browser writes to `material_stock_by_location` are closed off (read only). Variation materials from Stock come off the Warehouse in one step (`variation_material_add`). Invoiceable actuals count `job_material_usage` only (lines received to this job, less any moved off), never every received line on the job's POs.

### A11. Supplier invoice upload (AI extraction)
- Supplier, our account number, ABN, contacts, bank/BPAY, order reference and lines. Supplier matching (19 Oct 2026): our account number > ABN > bank details, each only when one supplier has it; a shared one (MMEM: Haymans and Greentech) asks a person to pick by account number. A name is only a suggestion ("Is this X?", never saved automatically) with filler words ignored (Pty, Ltd, Australia, Electrical, Solar...), and only when the bill's ABN or bank details do not belong to someone else. Before this, any "X Pty Ltd" half matched "WINAICO AUSTRALIA PTY LTD". Auto-creates new suppliers. Bills can be approved for payment.

### A11a. Emailed supplier bills (invoice@, AI agent)
- Suppliers email bills to invoice@thomsonenergy.com.au, a Google Group that delivers to sales@. Gmail filter on sales@: skip the inbox, label `Supplier Bills`, never spam. Only supplier bills go to invoice@.
- The Gmail sync flags those conversations (`email_threads.is_supplier_bill`): hidden from the Sales tab, no "New email" notification. It starts `process-supplier-bills-background` when a bill arrives, while any are waiting, and hourly. That function also searches the label for the last 30 days, so nothing is missed.
- One `supplier_bill_inbox` row per PDF or photo (migration 20261019000000). The file is saved to `project-documents/bills/emailed/`, read with the same AI reader as A11 (`_shared/supplier-invoice-ai.js`, now also returns `document_type`), supplier matched the A11 way, duplicates caught (same supplier + bill number, saved or waiting).
- PO matching (`_shared/supplier-bill-intake.js`): our PO number on the bill or in the email (confident only when that PO is this supplier's), then same-supplier open PO with the total within $1, then line descriptions, then the supplier's other open POs. Job and quote numbers (J2014, Job 2014) are never read as PO numbers. Top 3 kept as suggestions.
- **Emailed bills page** (`supplier-bills.html`, Admin/Finance/Sales): To check, Being read, Saved, Put aside. Per bill: pick supplier if not recognised, pick PO (suggestions first), **Save bill** (one tap, links lines to PO lines and flags extras/price rises like A11, leaves stock and material prices alone), **Review in full** (the A11 review screen with the file and reading filled in), Not a bill, Try again.
- Push notification `supplier_bill` to Admin and Finance when one needs checking (per-person switch on the bell).
- Every bill's supplier details are checked with the ABN Lookup (`_shared/supplier-verify.js`, `_shared/abr.js`, migration 20261020010000): ABN must exist and be active, its registered or trading names must match the bill, GST charged needs GST registration, and bank details or ABN different from the saved supplier are flagged (fake-invoice check). No ABN on the bill: a likely ABN is suggested. Any problem stops automatic saving and shows on the bill.
- No matching supplier: one is created from the bill (registered name that matches the bill when the ABN checks out, ABN, bank/BPAY, contacts), typed Supplier or Contractor by the AI (goods vs labour/services), marked **New, check details**. Bills from it cannot be approved for payment (by hand, by PO received or by the bill check) until a person opens the supplier and presses Save.
- Suppliers and contractors are one list (`suppliers.kind`), tabs All / Suppliers / Contractors / New, check details on the Suppliers page. Staff subcontractors stay on Team (Overheads tick).
- The bill reader is called **Tally** on the ops page. **Auto replies** (migration 20261103010000, `_shared/routing-replies.js`, Settings > Email Auto Replies: Off / Drafts / Send automatically, starts on Drafts): an invoice@ email with no invoice, statement, credit note or price list gets Tally's "this mailbox is for invoices, statements and price lists only, please use sales@". A supplier invoice sent to sales@ is spotted by **Postie** (the email agent, A18), passed into this intake, and gets "we forwarded it this time, please send invoices to invoice@ and update your contacts, with our PO number on every invoice". Drafts land in sales@ Gmail Drafts (Tally's from invoice@). One per conversation, one per sender every 14 days, never to our own addresses, no-reply senders, automatic mail or a supplier answering our query. Signature: the company signature with the agent's name and "Automatic reply from Thomson Energy". Logged in `routing_replies`.
- Auto-save is **off** (suggest only). With `api_keys` row `supplier_bill_auto_save` = `on`, confident matches are saved against the PO without a person. Never approves for payment, never touches Xero, stock or material prices.

### A11b. Emailed price lists (keeps material costs accurate)
- Price lists emailed to sales@ or invoice@ (invoice@ lands in sales@). Found by the Gmail sync (subject or file name says price / pricing / catalogue, with a PDF or spreadsheet), an hourly sweep of sales@, and anything the bill reader set aside as not a bill. Migration 20261019020000.
- `process-price-lists-background` (`_shared/price-list-intake.js`, `_shared/price-list-ai.js`): spreadsheets read row by row (AI only picks the columns, our nett/trade price, ex-GST); PDFs read 4 pages at a time across runs, a cut-off reply is re-read in halves; over 60 pages waits for "Read all pages".
- Every line kept per supplier in `supplier_price_items` (searchable on the page, with the previous price).
- Our materials are linked to supplier parts in `material_supplier_links`, confirmed once by a person ("Yes, same item"); after that matching is exact.
- Linked part moved under 20%: `materials.cost_price` updated automatically. 20% or more: waits. Part gone from the list, material not used in 6 months (PO lines, bill lines, job usage) and a similar new item on the list: "Looks replaced", switch (relinks, renames, new cost) or keep. Never deletes.
- Every change in `price_changes` with old and new cost, can be undone. Activity logged on the material.
- **Price lists page** (`price-lists.html`, Admin/Finance/Sales): To check, Price lists, Changes made (Undo), Supplier lists (search). `price_list` push to Admin and Finance. Reports to the ops manager; the 5am digest counts prices updated and changes to check.
- The manual price list upload on a supplier page (A11) still works as before.

### A11c. Bill checks and statement reconciliation
- Every supplier bill (emailed, one-tap, uploaded) is checked line by line against its PO (`_shared/bill-check.js`): not on the PO, price over 1% higher, more billed than ordered across every bill on the PO, PO total over 2%, same bill number twice, same amount within 3 days. Migration 20261019030000.
- `check_status`: matches, problems, no_po, queried, resolved. Matches + PO **closed** = approved for payment automatically (migration 20261108000000; before this, fully received was enough). Approval by hand (Bill checks page, or the supplier page for bills with no PO) runs on the server through `supplier-checks` (Admin, Finance and Sales, who and when recorded, refused for a "New, check details" supplier).
- **Pay-on date** (`supplier_bills.pay_on`, migration 20261108000000): the later of the supplier's terms date (`due_date`, still shown as "Terms due") and the day we approved. Set on every approval (Close, bill check, by hand), cleared on reopen. **Overdue** on the Suppliers pages = approved, past its pay-on date, not paid.
- **Paid** (migration 20261108000000): Suppliers page **Pay bills due** lists approved bills with a pay-on date of today or earlier, by supplier with bank-details check; tick the suppliers, set the paid-on date and a reference, **Record as paid** (one `supplier_payments` row per supplier per batch, each bill gets paid, paid_at, paid_by, payment_id, reference). The supplier page has **Paid** / **Not paid** per bill (Admin/Finance). Money is still sent in Airwallex or by bank transfer by hand; Airwallex payouts are a later build (needs a payout key, beneficiaries, accountant sign-off).
- **Reviewed bill save** (`supplier_bill_save_review`, migration 20261108000000): the supplier page's review screen saves in one server step, all or nothing: duplicate check by normalised bill number (INV-0103 = inv103 = 103; the emailed path uses the same rule), optional new PO with its lines, bill, lines linked (replaced generic line, same Stock item, or same description) or flagged. It never touches stock counts: gear lands in stock or on the job when the PO line is received. Open POs for linking = `closed_at is null`.
- Problems: **Query supplier** drafts an email listing each difference; a person edits and presses Send. Sent from invoice@ via sales@ (needs the "Send mail as" setting, `docs/EXTERNAL_ACCOUNTS.md`). The reply links back to the bill. **Accept as is** with a reason.
- Statements: emailed ones (bill reader's statements, plus "statement" emails in sales@) read automatically; uploads on a supplier page still work and are reconciled on the server too. Two-way check (`_shared/statement-intake.js`): missing bills (one-tap email asking for copies), amounts that differ, invoice listed twice on the statement, bill entered twice in TEops, our unpaid bills not on the statement, bills with problems or no PO, balance vs our unpaid total. Payments and credits on the statement are ignored for matching.
- Missing statements: from the 10th, suppliers that billed us last month with no statement since (one-tap "Ask for a statement").
- **Bill checks page** (`supplier-checks.html`, Admin/Finance/Sales): To approve, Problems, Statements, Missing statements. `statement` push to Admin and Finance. Worker `statements` (hourly at :30) reports to the ops manager; the digest lists bills to approve, problems, statements not reconciling, missing statements and queries waiting on suppliers.

### A12. Stock locations
- Warehouse plus each `holds_stock` vehicle as separate rows; `materials.quantity_on_hand` is a trigger-kept total. Stock page: total cost, minimums, location breakdown, "Suggest restock PO". Vehicle stock pages.
- **Stock from My Day** (migration 20261110000000): **Used stock on this job** under the clocked-in job on My Day, and after every clock-out on a job the question **Did you take any stock for J...?** (once per job per Sydney day). Where from (the van assigned to the person first, then the last place used, then Warehouse), search or Recent, big + / - counts, **Left in the van?** prefilled from the app's count on every line (a wrong count is fixed on the spot and logged), **Not in Stock? + Add it** (name, took, left). Done makes a closed stock PO through `po_create_stock_pull`, costed to the job.
- **Needs a price**: a part added from site is made at $0 with `materials.needs_price`; it shows red on the Stock page ("Stock checks" card and a chip on the row) and on the stock PO line on the job. When Admin / Finance / Sales set its cost, the stock pull lines and job cost rows that were at $0 take the price (trigger `materials_price_fill`).
- **Consumables** (`materials.is_consumable`, `pack_label`): counted by the pack (bag of 100 ties), never asked about at clock-out. **Running low** is one tap on the vehicle page, in the clock-out stock panel ("Anything running low?") or a stocktake: Admin and Finance get a `stock_low` notification and the Stock page lists the flags until **Restocked, clear**.
- **Count corrections on the Stock page**: a "Stock checks" card with Running low flags, parts that need a price, and the last 90 days of count corrections (who, when, app had / actually), plus a "Count corrected <date> by <name>" chip on any item corrected in the last 30 days. Every correction, move and price is logged on the item.
- **Stocktake** (`stock_stocktake`): Stock page (Warehouse) and each vehicle page. Every item recorded at that place, type the real count, consumables as OK / Low / Out, one Save; differences become logged corrections.
- **Move stock to a van** (`stock_transfer`): vehicle page **+ Move stock here from Warehouse** moves counts in one step with the same "Left at the Warehouse" check (no PO). The vehicle page's Create PO is now only for buying from a supplier.

### A12a. Tools and equipment register (migration 20261111000000, 20 Oct 2026)
- `tools.html` (Purchases menu): every tool and perishable (drill bits, blades, hole saws) the company owns. Fields: name, kind (tool / perishable), category, serial number, quantity, purchase date, cost ex GST, supplier, the bill and PO line it came from, who bought it, where it sits (**Warehouse or a vehicle, never a person**), status (in use / broken / replaced / lost / sold / written off, with a note, who and when), warranty end, test and tag due, photo, receipt, notes. Tabs: All, Tools, Perishables, Needs details, Broken lost gone, **By vehicle**. Anyone adds (+ Add tool, for a counter receipt) or edits (status, location, serial, photo, receipt); only pricing roles set the cost or delete. Photos go through `compressImage()` to `project-documents/tools/`.
- **Over $500 ex GST** a tool shows **Needs serial, photo, receipt** (whichever is missing; the supplier bill on file counts as the receipt) until all three are on it. Test and tag overdue is flagged.
- **Tools PO** (`purchase_orders.po_kind` tools, Purchase Orders page "This PO is for: Tools and equipment", kind Tools or Perishables, where they will live) and **any PO line marked as a tool** (`is_tool`, `tool_kind`; the **Tool?** button on a line, pricing roles; a received line is taken back off the job or stock and landed in the register at the same place). Receiving a tool line goes to the Tools register at the Warehouse or in a vehicle (destination `tools`): one row per tool, one row with the quantity for perishables, with the PO's supplier and bill; never a job cost, never stock. Undo received removes the rows unless one is already broken, lost or sold. Receive all skips tool lines.
- **By vehicle**: perishables bought in the last 12 months by where they went, count and cost, driver's name from the vehicle, against the fleet average per van (150% or more in red), with the most-used items. Each van has one driver, so heavy use shows by vehicle.
- Later (backlog item 1): Tally flags tool-like bill lines, test and tag reminders, Xero fixed asset push.

### A13. Job tasks
- Tasks page: Edit (reopens the Add task panel, with Delete), due dates as 19 Oct 2026 with Overdue in red and Due today in bold, sorted required first then soonest due (UX 14). Task buttons are full size with a busy state (UX 3, and My Day UX 8).
- Added at quote stage or later; assign to a person, a role or anyone. Tasks page; Home "Needs attention" count.
- **"Required before scheduling" is enforced** on every Schedule entry point and drives awaiting_action (A6).
- Take photo on any task (open the task): saved as a site photo captioned "#task <task>" (`project_photos.task_id`), thumbnails and count on the task. Ticked tasks show who ticked them and when.
- A task can only be ticked once all its subtasks are ticked (database trigger, migration 20261025000000); ticking a task no longer ticks its subtasks.
- Move a subtask to another task or out on its own, or put a task (with no subtasks) under another task: "Move to" in the open task.

### A13a. Activity log
- One `activity_log` table (`logActivity()` / `renderActivityLog()`), shown as a sidebar on the job page. Covers POs, jobs/quotes (stage edits), invoices, suppliers, materials, clients, tasks, documents, variations, timesheets. Not yet: settings changes, schedule changes.
- Timesheet lines name the day the entry was for and read "was X, now Y" (e.g. `Timesheet edited for Fri 16 Oct: was 7:00 am - 8:45 am, now 1:00 pm - 3:00 pm`). Added entries on a job are logged, and an entry moved between jobs is logged on both jobs. Description sits full width with name and time underneath.
- Split by job tab (`renderJobActivityLog()`, code only, tab worked out from the action so old entries sort too). **Summary** shows one short line per action: a run of changes by the same person on the same thing within 30 min becomes one line (`Edited PO 1234 (3 changes)`, `Edited timesheets (20 changes)`, `Updated 4 tasks`). **Every other tab** shows only its own entries in full (PO tab: `PO 1234: Cable qty 10 to 15`; Cost Centres: timesheets and stages; Variations; Invoices; Documents). PO line items added or overridden on the job are logged per item.
- The log box fits the screen and scrolls on its own: mouse over the log scrolls only the log, mouse on the page scrolls the page. Same rule app wide for every inner scroll box (`overscroll-behavior: contain`), and the page behind a popup stays put while it is open.

### A13b. Number-first references
- `projectRef()`: `J{job} - {name}`, or `Q{quote} - {name}` before approval, everywhere.

### A13c. Logs page
- `logs.html` (admin): login history and the global activity feed with filters.

### A14. Roles, permissions and sessions
| Role | Access |
|---|---|
| Admin | Everything |
| Finance | Invoices, payments, POs, timesheet dashboard, Overheads, Incidents, HR |
| Sales | Pricing and quoting, Schedule editing, no Xero/payroll |
| Staff | Jobs, notes, photos, checklists, own timesheets, read-only Schedule, no pricing |
- Enforced with RLS; a BEFORE UPDATE trigger stops users changing their own role or admin fields.
- **Dev Mode:** admin enters a password (checked server-side against `DEV_MODE_PASSWORD`, `verify-dev-mode.js`) to unlock Company Details, Xero Mapping, API Keys and bulk delete for 20 minutes.
- **Log out everywhere:** sign-out ends every session; other tabs and devices check with Supabase on load, on focus, every 5 minutes and on any refused call, then go to login.
- Password reset with branded email and scanner-proof links; admin can also set a password (`create-user-with-password.js`).

### A16. Pylon
- Pull: panel/inverter/battery counts and hardware summary from Pylon `solar_designs` (`pylon-sync.js`).
- Push: "Create job in Pylon" creates the Pylon project with client and site filled in (`push-to-pylon.js`). Pricing stays in the app.

### A17. Job page
- UX delivery 3: the open tab is in the URL (`?tab=`), Staff see Summary, Site Photos, Documents, Feed first, the strip scrolls to the open tab; task ticks, stars, assignees and due dates show at once and save in the background; pipeline stage badge in the header (`PIPELINE_STAGES` shared with the board); Show line items toggles in place; Save, Generate PDF and the site-visit ticks confirm; unsaved quote edits ask before leaving; removing hours, materials or bookings asks first and a stock material goes back on the shelf through `variation_material_delete` (migration 20261107000000); document and site photo Delete only for the uploader or Admin / Finance (project_photos delete policy); photos lazy load grouped by day; feed has Show older notes (UX 32, 34, 37 to 41, 43, 44, 46, 48, 54 to 56).
- Tabs: Summary · Cost Centres · Purchase Orders · Variations · Invoices · STCs · Details · Feed · Emails · Documents · Site Photos, plus the Activity sidebar.
- Summary: stat cards, budget bars, "Quoted split" and "Job split" donuts, "On this job now".
- Labour cost everywhere (job page, Projects list, timesheet drilldown, warranty cost) is wages plus **direct** overhead (each person's direct rate from Overheads, company average for the estimate). Underneath, pricing roles see "incl. overheads $X", which adds **indirect** overhead (plus company overhead on the cost tiles for Finance and Admin). Labour budget % is worked out server-side in `get-accrued-labour-cost.js` so Staff see the same % as Sales (they cannot read `estimated_labour_cost`).
- Cost centre cards show labour plus materials quoted vs actual and GP%.
- Header shows the site address (maps link), client phone (tap to call) and email under the subtitle (19 Oct 2026, UX 31).
- Compliance (CCEW) and Installed equipment cards sit on the Summary tab for every job with a J number, from the day it is booked; Needs attention shows "No CCEW uploaded yet" until a certificate is uploaded or a not-required reason saved (UX 19).
- The handover checklist and the default handover task read the CCEW from the card (`projects.ccew_file_path`, or a saved not-required reason) (UX 20). CCEW upload is one button; View certificate signs a fresh link on each tap (UX 23, 30). Staff do not see the Formbay row or the checklist button (UX 26).
- Installed equipment: new solar, generator and air con assets default to a 12 month service; Add and Edit lock on tap; Log service saves the whole form; saving a solar or inverter asset copies its serials onto the job's handover fields (`syncAssetSerialsToProject` in `assets.js`); from a job the form skips the customer search; several Pylon items open as "Equipment 2 of 3" with Skip (UX 24, 25, 27, 28, 29). Serial and NMI boxes have autocorrect off (UX 21).
- Site photo upload shows "Uploading n of N...", saves each photo as it lands, keeps the good ones on a failure with a Retry for the failed files (`wireSitePhotoInput`, `uploadPhotosBatch` in `supabase-client.js`, also used by the clock-out photos) (UX 35).
- Plan markup (`openPdfViewer` and `openPhotoMarkup` in `supabase-client.js`, 21 Oct 2026): a PDF in Documents opens page by page; Mark up this page opens the editor (pen, arrow, box, text, electrical symbols, scale, measure, cable paths, schedule). The viewer and the editor zoom with + / - buttons, pinch or ctrl + scroll (two fingers pan the editor, one finger pans the viewer); taps that delete or place a symbol act when the finger lifts so a pinch never places anything. Save markup asks **Replace this document** (same name and tile: new file stored, the row pointed at it, the old file removed) or **Save as a new document** with a name (default "<name> - marked up", suffixes never stack); generated quote and invoice PDFs offer Save as new only. The saved document reopens on the same page. Drawings are written as vectors over the original page through the renderer's own page transform (`toPdf` from `renderPdfPageToDataUrl`), so they land where they were drawn whatever the page's box origin, crop or rotation; the page is flattened to a picture only if that fails. Before 21 Oct 2026 the writer used pdf-lib's media box at 0,0, which shifted the drawings on plans whose page box does not start at 0,0 (J7040), and every save made a new "(marked up)" copy.
- Documents and PO files open on iPhone through `openSignedDocInNewTab` (blank tab opened on the tap, then pointed at the signed link); same helper on Knowledge, Documents and HR files (UX 33).

### A18. Sales inbox and My inbox (Gmail)
- `inbox.html`: toggle **Sales inbox** (sales@, every staff member) | **My inbox** (the logged-in person's own work Gmail, private to them). Migration 20261021020000 (`mailboxes`, `mailbox_tokens`, labels, drafts, sender rules, clean up, Gmail notice).
- `sync-gmail.js` every 5 minutes (sales@ first, then each My inbox from Gmail history, including read and archive changes made in Gmail), Sync now via `sync-gmail-now.js`. HTML viewer, inline pictures, attachments. sales@ reads Gmail history a page at a time and saves its starting point after every page; mail already in TEops is ruled out a page at a time, drafts, spam and bin are never fetched; a 10 second budget (Netlify's scheduler retries at 15) with a lock (`api_keys` gmail_sync_lock) so only one sales@ sync runs; a backlog carries on in `mailbox-work-background.js` (up to 6 minutes a run). If the starting point is older than Gmail keeps, it loads the last 14 days. My inbox mailboxes use the same page logic (known mail ruled out in one query, drafts skipped, 4 at a time) since 21 Oct 2026.
- Sections sorted by the email agent, **Postie** (`_shared/email-agent.js`, run by `mailbox-work-background.js`; also passes supplier invoices sent to sales@ into invoice@, A11a): **Priority** (someone waiting on our reply, with a one-line reason; drops off once we reply), **Other**, **Subscriptions and updates**, plus Sent, Done, All. Order: the person's "always for this sender" rule, Gmail's Promotions/Social/Updates/Forums tabs and unsubscribe headers, then Claude Haiku 5.5. Move any conversation; Done archives (in Gmail too).
- Labels (Gmail style) for non-job matters (a supplier dispute, a licence application): sidebar with counts, Open or Finished, description tells the agent what belongs. The agent applies existing labels (a near match in name counts as the same label) and suggests new ones (a person confirms). Sales inbox labels are shared, My inbox labels are private. Mirrored to Gmail as `TEops/<name>`.
- **Label sweep** (migration 20261105010000, 20 Oct 2026): a new label, or a changed description, sets `email_labels.sweep_requested_at`; the mailbox worker then has Postie go back over that inbox's last 60 days (`email_label_sweep_candidates()`, conversations not carrying the label, 25 at a time, Haiku 5.5) and file the ones that clearly belong. Carries on next run if time runs out. The person who made the label (or admin and sales for an agent-made sales@ label) gets one notification: "Label X: 7 conversations filed", linking to the label (`/inbox.html?label=<id>`). Label header shows "checking the last 60 days..." then "Older mail checked".
- **Labels made by Postie** (`mailboxes.auto_labels`, off by default, Settings > Email Agent > Labels made by Postie; sales@ by Admin, Finance or Sales, a My inbox by its owner): with it on, instead of suggesting, Postie makes the label itself with a one-line description of what belongs, marked `by_ai` (AI tag in the sidebar and label header), files the conversation and asks for a sweep. Duplicate guard: the prompt lists every label (finished ones too) and says to reuse; the server treats names with the same words in any order, or one name's words all inside the other's, as the same label.
- **Who has it** (`email_threads.assigned_to`, `assigned_by`, `assigned_at`): every row and the open conversation show "Nobody has replied yet", "Jasper replied 2h ago, waiting on them", "Replied from Gmail (sales@)" (a reply sent outside TEops, Gmail does not say who) or "Dan is on it (claimed 20m ago)". "I've got this", "Assign to..." (active staff picker, the person gets a notification with the link), "Not mine any more", "Take over". Sending a reply from TEops claims an unclaimed conversation for the sender. Opening a conversation someone else has claimed shows a banner above the reply box. Priority lists unclaimed first; a "Mine" tick box on every list shows only what is assigned to you. The "New email" notification goes only to the person handling the conversation when there is one (`trg_notify_email`), otherwise to admin and sales as before. In a My inbox, assigning to someone else needs the conversation tagged to a job first (so they can see it). `email-actions` `assign`.
- **Tagged to jobs** (sidebar, under Jobs): this inbox's conversations tagged to a job in the last 30 days, grouped by job (J or Q number, name, client, "2 need a reply"), newest job first, each row with the status above. The job page's Emails tab shows the same status line and an assign picker on every tagged conversation, across every inbox.
- Jobs: the agent tags when sure ("tagged by Sparky", dashed, one tap to remove) and suggests when guessing. Tagged conversations show on the job for everyone, including from My inbox; untagged My inbox mail stays private.
- Drafts: the agent (Claude Opus 5.5) drafts replies to Priority mail from the last 7 days, with [gaps] for facts it doesn't have. Draft shows at the bottom of its conversation and in the **Drafts** list (top right, with a count), and in Gmail drafts. Nothing sends without a person pressing Send.
- **Writing style** (migration 20261103020000, `_shared/writing-style.js`, Settings > Email Agent): Postie drafts in the mailbox owner's own voice. "Learn from sent mail" reads the replies already sent from the mailbox (the outbound emails TEops holds: 60 days of backfill for a My inbox, everything since connection for sales@), strips signatures, quoted text and forwards, and asks Claude Opus 5.5 for a short guide (greeting and sign off, length, tone, how questions are answered, saying no, prices and travel, phrases, never dos) plus up to 8 real replies kept verbatim as examples (paired with the email each answered). Saved on `mailboxes` (`writing_style`, `writing_style_examples`), editable in Settings; Learn again keeps hand edits; refreshed by itself every 30 days once learned. The mailbox worker does the reading (`writing_style_requested_at`), Settings polls. Needs at least 5 sent replies. sales@ is edited by Admin, Finance or Sales; a My inbox by its owner.
- **Company voice** (migration 20261103030000): Admin picks one mailbox's learned style as the company voice in Settings > Email Agent (`company_settings.writing_style_mailbox_id`, jasper@ from the start). Every mailbox drafts in it unless switched to its own style (`mailboxes.writing_style_source` = company / own, default company; own with no learned style still uses the company voice). Other mailboxes get the guide and the writer's own words from the examples, never the emails they were answering. Resolved in `resolveStyle()` (`_shared/writing-style.js`).
- Drafts answer rather than recap: never repeat or summarise what the sender wrote, first sentence is the answer, one line per question asked, three to six sentences unless more is needed, one [gap] inside the answer line for a missing fact, no hedging paragraph.
- **Clean up** (sidebar): scans the whole Gmail inbox however far back by sender (count, unread, unsubscribe link), the agent suggests Archive / Worth a look / Keep per sender (clients always Worth a look), then one tap archives, marks read or unsubscribes (one-click link or unsubscribe email) a whole sender. Also "mark everything older than N days as read". Nothing is deleted.
- My inbox connect: anyone, from Inbox > My inbox. A Workplace Surveillance Act 2005 (NSW) notice pops up first: "I agree and waive the 14 days notice" connects now; "I don't agree" locks Connect for 14 days from the notice (checked on the server, `gmail_connect_allowed_from()`). Recorded in `gmail_connect_notices`. Loads the last 60 days, then new mail. Disconnect removes private mail from TEops, keeps job-tagged conversations.
- Reply and compose with attachments (My inbox replies go from the person's own address, signature shows that address); tag conversations to jobs; Emails tab on every job with "Email the client" (a reply there to someone else's My inbox conversation goes from sales@ as a new email).
- Create a quote or job from an email (AI reads client, site and work).
- Signatures show sales@thomsonenergy.com.au (or the person's own address from My inbox) and 0455 415 464.
- Gmail permission: gmail.modify + gmail.send. sales@ must be connected once more in Settings for labels, drafts, Done and Clean up to reach Gmail; until then they stay in TEops only.

### A19. Feeds, meetings, job extras
- Company feed and per-job feed (likes, comments, tags).
- Site photos on feed posts (item 30, 22 Oct 2026): a job post can carry site photos (`feed_post_photos`, migration 20261119000000). Add photos on the job's Feed composer (uploaded as site photos first, so they also show on Site Photos), Post to feed in the photo viewer, or Select photos to post on the Site Photos tab. Each opens a message, @ tag people (notified as any tag) and the Also show on the Home page tick. Posts are made by `create_feed_post` (post, tags and photos all or nothing; photos only from the post's own job). Feed cards on the job and Home show a photo strip that opens the viewer. Deleting a post leaves the photos; deleting a photo drops it from the post.
- Meetings: record, transcribe, analyse; follow-up tasks with reminders.
- Installer summary on the job card; recent jobs for the same client; search within a job.

### A19a. Team chat (migration 20261020000000, live 18 Oct 2026)
- Chat page (`chat.html`, `js/chat.js`, `css/chat.css`) and a chat icon with unread count in the top bar. Replaces WhatsApp.
- Channels: General and Social for everyone. Anyone can make a channel for people they pick (group chats are channels); only Admin makes Everyone channels. Whoever made a channel, or Admin, renames it, changes who is in it and archives it; the maker stays in it unless Admin takes them out (migration 20261113000000). DMs: one to one only, anyone can start. Chats are never deleted.
- Messages: text, photos (through `compressImage()`), files up to 50 MB, voice messages (tap the mic, tap Send), @mentions, threads, edit and delete your own (admins delete any). Private `chat` bucket, folder per chat.
- Job tags: type # (or the # button) to pick a J or Q number. Tagged messages show on the job's Feed tab under "From team chat" (only to people in that chat).
- Instant delivery by Supabase Realtime; `chat-after-send.js` pushes notifications straight away. Notification types chat_dm, chat_mention, chat_reply, chat_message, each switchable; mute per chat. Thread replies only notify people in the thread.
- Offline: every message saves to an IndexedDB outbox first (time = when Send was pressed), shows "Waiting for signal", sends when back online; `client_id` stops duplicates.
- Sparky in chat (a member of every chat, channels and DMs, no AI consent needed; owner's lawyer, 18 Oct 2026): tags messages to jobs (explicit J or Q number straight away, otherwise Haiku 5.5 tags when sure and suggests with Yes / No when guessing, "tagged by Sparky" with Undo, can tag the earlier question a J number answers); turns voice messages into text (AssemblyAI then a cleanup pass); answers @Sparky with read-only lookups run with the asker's own access (Opus 5.5). In Social it only tags work talk and never sees the chat history. Code: `_shared/chat-ai.js`, `chat-ai-background.js`, `chat-ai-sweep.js` (every 2 minutes, catches anything missed). Sparky's lookup tools now live in `_shared/sparky-tools.js`, shared with the Ask AI widget.

### A20. Notifications
- Bell plus Web Push to phones (per device, app badge), per-type switches. `send-notifications.js` runs every minute.
- Types: tagged, comments, tasks, task reminders, meeting follow-ups, schedule bookings, new emails, reviews, call reminders.
- Website "Book a call" requests: up for grabs on Home; claiming moves it to **Your calls** (Done / Release) with a reminder 5 minutes before.

### A21. Reviews
- "Ask for a review" when emailing a client; no-account review page (stars, comment, optional Google link). Reviews page with average, filters, copy for website.

### A22. Quote and invoice documents
- UX delivery 3: "Create invoice" emails the client with the PDF attached and every invoice row has an Email button; the due date fills from the client's payment terms; the client quote page keeps Approve in a bar at the bottom on a phone; the customer invoice and PO pages show a readable summary card above the A4 sheet on a phone (UX 45, 64, 67, 74).
- Quote: A4 proposal pages (cover, project, scope, investment summary, photos, schedule of rates for estimates, T&Cs); header on every page but the cover. Investment summary: a long stage table carries on over extra sheets a row at a time with its column headings repeated; the payment schedule (set tighter), valid-until line and approve link move onto the next sheet together when they do not fit under the totals. Investment breakdown (tick box on the quote edit form, off by default, `projects.show_investment_breakdown`): a page after the summary listing each stage's items (description and quantity, prebuilds as one line by their client description, no item prices) with the stage price ex GST as the last row; not on variation pages or quick estimates; long stages carry on over extra sheets.
- Invoice: A4 template with OVERDUE and PAID stamps; PDF remade when a payment is recorded. Quoted jobs split labour and materials by sell value.
- **Do-and-charge invoicing:** on a Direct Job, claim several cost centres in one or separate invoices and add Stock materials and prebuilds straight onto the invoice (migration 154, `invoice_line_items`).
- PDFs made in the background on save (`generate-client-document-pdf.js`, 4096 MB); `warm-pdf.js` every 4 minutes keeps it warm.

### A23. AI assistant (Sparky, name set in Settings)
- Chat on every page: database search, calculations, web search. Prepares tasks, schedule changes and timesheets and prefills forms; every change needs the user's confirm and runs with their permissions.

### A24. Overheads and net profit
- `overheads.html` (Finance). Overheads v3 (migration 148, built on 141/142): **direct** employee overhead per person (on-costs, leave, public holidays, training over their billable hours), **indirect** employee overhead (non-billable wage hours spread over all billable hours), **company** costs as a share of job profit or price.
- Xero expense accounts are mapped to buckets on the page (`sync-overheads.js`); `sync-overheads-nightly.js` refreshes from the Xero Profit and Loss report daily.
- `get_project_overheads` (net profit per job, job page) and `get_monthly_net_summary` (business-level monthly net).

### A25. STCs and Formbay
- **Job STCs tab:** one row per Formbay job (PV, battery, hot water), booked price (normally $35), status through Formbay's stages to sold and paid; the quote's STC count is offered on the first row (migrations 147 `job_stcs`).
- **STCs page** (`stcs.html`): expected Formbay price and fee, all jobs, Formbay payments. Import a Payment Advice plus its FEE tax invoice PDF, read in the browser by `public/js/formbay-advice-parser.js`, checked before saving.
- STC credit includes GST for company clients, matching Xero (migration 153).
- `formbay-webhook.js` checks `X-Webhook-Secret` and stores every event raw in `formbay_webhook_events` (migration 146). Not processed yet (Part L).
- No own tax invoice is issued to Formbay (owner decision).

### A26. HR, incidents and letters
- **Staff profile** (`staff.html`, admin/finance, plus staff self-view of their own): overview, signed and HR documents, photos, written warnings, KPIs (migration 147, private `staff-files` bucket).
- **Incidents** (`incidents.html`, `incident.html`, migration 148): hub with people tagged by role, evidence, corrective actions, SafeWork and workers comp tracking; WHS Form 10.
- **Report from site** (migration 20261104000000, UX 5): every staff member has "Report an incident or near miss" on My Day (type, what happened, where, job prefilled from the clock-in, Sydney date and time, "I was hurt", camera photos). One database function `report_incident` creates the incident (open, reporter listed as Reported it or Injured), attaches the photos (`staff-files/incidents/<id>/`, staff can insert there only) and notifies Admin and Finance (kind `incident`, bell and push). Staff still cannot read incidents.
- **Letters** (`letter.html`, migration 148): warning and counselling letters signed in the app by manager and employee, with active period and resolution.
- Onboarding: staff enter their details, which fill their employment contract (rates and start date from Settings); contracts flip to signed when signed (migration 149).
- **Policy versions and consent** (migration 20261018120000): onboarding documents have a version and an optional type (Policy, AI consent, Location consent). Settings > Onboarding "Publish new version" makes everyone re-sign; `policy-update.html` is shown on login to anyone who finished onboarding but has an unsigned current version ("Remind me later" once per login or day, then a banner). Consent forms need I agree / I don't agree plus a signature; the answer sets `profiles.ai_consent_at` / `location_consent_at` by trigger (staff cannot edit them directly). My Profile has on/off switches (off is instant via `withdraw_consent()`, on means signing again); the staff editor shows versions signed and consent. Optional documents (Required unticked) no longer block onboarding. Shared signing panel: `public/js/document-signing.js`.

### A27. ServiceM8 import (one-time cutover)
- `sm8-import.html` (Settings > ServiceM8 Import, admin) via `sm8-import-preview.js`, `sm8-import-jobs.js`, `sm8-import-lines.js` (migration 153). Dry run, then imports open Work Order jobs; keeps the SM8 job number; skips jobs already imported, so it can be re-run.
- Jobs with a value import as `new_build` (so "Invoice project" bills the balance), others as Direct Jobs. One stage per job with SM8 line items: bundles as prebuild groups, standalone lines marked Labour/Material, paced for SM8's ~180 calls/minute.
- Lettered SM8 jobs (e.g. 4515A deposit) count toward invoiced to date.
- Review screen has a search (SM8 number, client, name, address) and starts with nothing ticked, so jobs and quotes can be brought across one at a time.
- Open SM8 quotes (status Quote, last N months, default 6, set on the screen) come across as TEops quotes with a Q number: Quote sent (with SM8's sent date) if `quote_sent`/`quote_sent_stamp` says so, else Draft quote. Same line items, client match, notes, checklists and files; quote/proposal PDFs go to Documents > "ServiceM8 proposal" and the run summary counts how many quotes have one (SM8's online proposals are not in its API). A quote that later became a Work Order is skipped by the job import: approve the TEops quote instead.
- STC lines are not applied: listed in the job notes and `projects.sm8_stcs` (migration 155), offered prefilled on the STCs tab.
- `sm8-copy-attachments-background.js` (migration 154 `sm8_attachment_copies`): pictures to Photos, other files to Documents > "ServiceM8", with retries. Starts by itself after Import.
- Labour and checklists (same background run, `_shared/sm8-labour.js`, migration 20261021000000): each recorded SM8 check-in becomes a time entry on the job for the matched person, marked already paid (`xero_pushed_at`), shown on the job only (hidden from Timesheets, staff KPIs, timesheet problems, never pushed to Xero). Every checklist item, ticked or not, becomes an unassigned onsite task. Staff matched on the import page (`sm8-staff.js`, `profiles.sm8_staff_uuid`); unmatched staff's time is skipped and listed in the run summary (`sm8_copy_runs`). Re-runs never double up. Lettered jobs (4515A-D) are folded in: their time, checklists, docs and photos land on the main job.
- Copy details (migration 20261021010000): AVIF photos and videos go to Photos (videos play in place), files already in Documents are moved on the next run. Photos and documents keep ServiceM8's date and the matched person who added them. Checklist groups become a task each with the items as subtasks (who ticked, when, reminder as due date and assignee). The run summary keeps a few raw ServiceM8 checklist records to check field names.
- ServiceM8 invoice PDFs (file name has "invoice") go to the "ServiceM8 invoices" folder, listed under "From ServiceM8" on the job's Invoices tab and hidden from Documents. Reference only: not `invoices` rows, so no Xero push and no change to invoiced to date. Each has a Delete button. "Partial Invoice #..." PDFs (ServiceM8's internal copy of each claim line) are not brought across; ones already copied are removed on the next run.
- File size: no bucket has its own limit, so Supabase's project-wide limit applies (Storage > Settings, default 50 MB). SM8 videos over it fail with "The object exceeded the maximum allowed size"; raise it to 500 MB and press the copy button again (failed files are retried).

### A28. Other built features
- Invoices page: search (invoice number, job number, job name, client) and a status select (Unpaid, Overdue, Paid, Not yet in Xero, All), opens on Unpaid; `/invoices.html?q=` prefills the search (19 Oct 2026, UX 123). Stat tiles count every invoice.
- **Leads and call requests** from the website forms (`leads.html`), converted to quotes or jobs.
- **Site inspections** (migration 104): "Needs a site visit" on a lead, quote or job; checklist filled on site (`site-inspection.html`); templates in Settings > Inspection Checklists.
- **Customer assets** with warranty and service reminders (`assets.html`).
- **Licence sharing:** a live link to a chosen set of company and employee licences (`share-licences.html`); licences and insurance with AI-extracted expiry on the Team page.
- **Knowledge base** (A32), **Tech Support** numbers, **Team**, **DNSP**, **Fleet**, **Bugs & Updates** board (synced to `BUGS_AND_UPDATES.md` by `sync-bugs-to-repo.js`).

### A30. Ops manager (AI agents, version 1)
- Workers report through `_shared/agent-log.js` (`runAgent`): supplier bill reader, sales@ email sync, phone notifications, nightly Xero overheads sync, nightly job archiving. Migration 20261019010000.
- `agent_heartbeats` (one row per worker: last worked, last failed), `agent_runs` (runs that did something or failed, with AI tokens; kept 90 days), `agent_tasks` (the "Needs me" list). Admin only.
- A worker not working for 3 of its usual gaps opens a "Needs me" task and sends one `agent_alert` push; the task closes itself when it works again.
- 5am Sydney digest (`ops-digest.js`, `ops_digest` push): what needs you, last 24 hours, workers not working, AI tokens.
- Recipients: `company_settings.ops_manager_user_ids` (Jasper only for now).
- **Ops manager page** (`ops.html`, Admin): Ask the manager buttons, Needs me (emailed bills to check, worker tasks with Done / Dismiss), latest digest, workers, what they did.
- The assistant is the manager in chat: reads the worker tables and emailed bills, and can line up `save_emailed_bill`, `put_aside_emailed_bill`, `close_agent_task` (Confirm needed, `_shared/ops-actions.js`). Cannot deploy, change permissions, move money, approve payment, push to Xero or send email.

### A31. Documents page (company documents, migration 20261022000000)
- **Documents** in the main menu (`documents.html`): company docs we send to clients. Table `company_documents` (kind `schedule_of_rates` or `file`). Everyone can view, add and rename; only Admin can delete; the Schedule of Rates cannot be deleted. Uploaded files sit in `project-documents` under `company-documents/`.
- **Schedule of Rates** (`rates.html`, public link, 2 A4 pages): the estimate's Schedule of Rates page without the estimate parts, live rates from Billable Rates through `get_schedule_of_rates()`. Wording shared with estimates in `public/js/schedule-of-rates.js`.
- **"Current as at"** date: `company_settings.rates_reviewed_on` (set 18 Oct 2026), printed on the standalone doc and on estimates. Moved to today by changing a rate or pressing "Rates checked, still correct today" in Settings > Billable Rates.
- **6 monthly review:** the 5am ops digest opens a "Needs me" task (dedupe `rates_review`, one push) once 6 months have passed, and closes it when the date moves on.
- **On a job:** Documents tab > Add from Documents. Files are copied into the job's "Company docs" folder; the Schedule of Rates is printed to a PDF at today's rates (`generate-client-document-pdf.js`, `doc_type: schedule_of_rates`, logged-in staff only). Then attach from the job's Emails tab as usual.

### A33. Spell check and Polish (every multi-line text box, migration 20261103030000)
- `js/writing-help.js`, loaded by `supabase-client.js` on every page once signed in. Attaches to every `textarea`, including ones added later. Single-line inputs are never touched; boxes whose id, name or class looks like keys, serials, codes or data, anything inside `[data-no-writing-help]` and the API keys panel are skipped. A parent with `data-wh-anchor` gets the bar after it (chat composer).
- **Spelling** (`polish-text.js`, mode spell, Claude Haiku 5.5): Automatic by default, after a 2.5 second pause and on leaving a box the person typed in. Spelling and obvious typos only, Australian spelling, never names, numbers, part numbers, units or trade words; a result with a different word count is thrown away. "Spelling fixed, Undo" under the box; Undo also stores the changed words (this device, up to 200) and sends them as "leave these alone". Chat fixes before sending, waiting at most 1.5 seconds.
- **Polish** (mode polish, Claude Sonnet 5.5): button under a box with 5+ words while it has focus. Restructures in the person's voice (their inbox's own style if set to own, else the company voice, A18), keeps every fact, adds nothing. "Polished, Undo".
- Per person: Settings > Email Agent > Spell check: Automatic / Only when I press Fix spelling / Off (`profiles.spellcheck_mode`).
- The text only changes in the box (input and change events fire), the page saves it as it always did. `cleanup-text.js` now checks the login too.
### A32. Knowledge Base and its background reader (migration 20261104010000, 19 Oct 2026)
- `knowledge.html`: pasted text, a linked website, or an uploaded file (PDF, image, spreadsheet, text). Every entry is stored page by page in `knowledge_pages` (a PDF's real pages; other text in parts of about 5,000 characters), kept in step with `knowledge_entries.content` by a trigger, so a hand edit (Edit button) rewrites the pages.
- **Background reader** (`read-knowledge-background.js`, `_shared/knowledge-reader.js`, queue `knowledge_read_jobs`): a PDF upload, or **Read again** on a PDF entry, queues a read and the server does the rest, nothing has to stay open. Page by page: the PDF's own text layer first (free, exact); a page whose text is thin, has a table, or is full of unmapped glyphs is rendered on the server (pdf.js plus @napi-rs/canvas) and read by Claude (Sonnet 5.5) as a picture, one page per call. **Read again** offers: only the failed pages, every page (text first), or every page as pictures. The entry shows "Reading: 212 of 610 pages", Stop (the person who queued it), and the person gets a `knowledge` notification when it finishes. A run works for 11 minutes then calls itself for the rest; `read-knowledge-sweep.js` (every 2 minutes, in the ops manager's worker list) restarts a run that died.
- **Copyright filter:** Anthropic blocks some word for word pages of a purchased standard ("Output blocked by content filtering policy": 172 pages of AS/NZS 3000 the first time). A blocked page is tried once more, then asked for as reference notes (clause numbers, requirements, table values) and marked `notes`; blocked even then it is marked `failed` with the reason, and the entry says which pages. Sparky says when an answer comes from a notes page. A picture read that fails for any other reason keeps the page's text layer and notes the error; "Only the failed pages" retries those too. No Anthropic credits stops the job at once with the reason (top up at console.anthropic.com > Plans & Billing, then Read again).
- **Sparky's search** (`_shared/sparky-tools.js`): `search_knowledge_base` is Postgres full text search over the pages (`search_knowledge_pages()`, GIN index, clause and table numbers work, substring fallback) and returns document, page number and an excerpt; `read_knowledge_entry` reads whole pages (page_from, page_to) or searches within one entry. Used by Sparky in chat and the Ask AI widget.
- Non-PDF files and websites still go through `extract-knowledge-content-background.js` (logged-in staff only).
- Left over: the old `knowledge_ocr_parts` table is still on production (the migration's drop timed out in the MCP tool); nothing uses it. Drop it from the Supabase SQL editor: `drop table if exists public.knowledge_ocr_parts;`

### A34. Job Schedule tab, client booking emails, client time picks (migration 20261104020000, 19 Oct 2026)
- **Schedule tab** on every job (`js/job-schedule.js`, loaded by `project.html`): bookings by day with "Client informed <date>" (green) or "Client not informed" (amber) badges, each person with a remove cross, Move and Cancel per day, "Mark as told" (phone or in person). Buttons for Admin, Finance and Sales: Book people (the existing Book form, now with an "Email the client this booking" tick box), Email client booking, Ask client to pick a time. Plain staff see the list only. Below: time options sent to the client (status, dates, picked one, opened or not, Copy link, Withdraw) and every schedule email (kind, to, sender, date, Open email). The job activity sidebar shows booking actions under this tab (`JOB_ACTIVITY_TABS`).
- **Flow:** book tentatively as far out as you like (staff see it in My Day; the Schedule page and My Day mark it "tentative" until the client is informed). When the job is sure to go ahead, **Email client booking**: tick the days, check the drafted text (job name and number, when, where, who; written by the server, editable, spell check and Polish apply), Send. Goes from sales@ in the sender's name with their signature through `_shared/send-recorded-email.js` (the one send-and-record path, which `send-gmail.js` now also uses), tagged to the job, logged in `schedule_emails`, and the days turn Client informed. **7am reminder** (`remind-client-bookings.js`, 20:05 and 21:05 UTC with a Sydney hour guard): whoever made a booking (`schedule_assignments.created_by`, filled by `auth.uid()` in the browser) starting within 3 days with the client not informed gets a phone notification (kind `booking_reminder`); bookings with no maker go to the ops managers.
- **Move:** new day and times for everyone booked that day; "Email the client the new time" (ticked when they were told the old one). Without the email the day goes back to "Client not informed". Staff get a phone notification either way. A drag to a new time on the Schedule page also clears Client informed.
- **Cancel:** removes everyone that day; "Email the client" (ticked when they were told) and "Offer new times" (the time options form below, with the day's people and times filled in, sent in the same email with the pick-a-time button). Staff get a phone notification.
- **Ask client to pick a time:** who, start and finish, days per option (1 to 10, weekdays only by default), 2 to 6 start dates; a date where someone chosen is already booked shows red with who and when, and cannot be sent. The client gets the drafted email plus a private link button (`pick-time.html?token=`, `schedule_time_offers.token`). The page (`get-time-offer.js`, public, token only) shows job number and name, site address, time, first names, the options as buttons (ones no longer free are greyed "No longer available"), and "None of these work for me" with a message box. Picking one (`pick-time.js`, public) calls `book_time_offer()`: re-checks everyone is free (no overlapping booking and no approved leave, `time_offer_person_busy()`; one pick at a time per person), books every person for every day of the option all or nothing, already Client informed, closes the options, then emails the confirmation in the sender's name (recorded on the job) and notifies them. A slot taken meanwhile comes back as "taken" and the page greys it out. Declining notifies the sender with the client's message. Withdraw stops the link.
- **Schema:** `schedule_assignments` gets `created_by` (no foreign key on purpose: a second link to profiles would make the `profiles(...)` join in every schedule query ambiguous), `client_informed_at`, `client_informed_email_id`, `time_offer_id`, plus indexes on project and date, staff and date. New `schedule_time_offers` and `schedule_emails` (select for staff, written by the server only). Functions `time_offer_option_dates`, `time_offer_person_busy`, `time_offer_option_status` and `book_time_offer` (the last three service role only). Bookings made before this change were set Client informed at their booking time (confirmed the old way), so only new bookings start tentative. If the confirmation email after a pick fails (sales@ not connected, Gmail down) the booking still stands, the client page says so, and the notification and activity log say "Confirmation email NOT sent".
- Not emailed to staff on purpose (owner, 19 Oct 2026): they see bookings in My Day and get the existing "You are booked" notification.

### A29. Scheduled functions (netlify.toml)
| Function | Schedule |
|---|---|
| send-notifications | every minute |
| warm-pdf | every 4 minutes |
| ops-digest | 18:00 and 19:00 UTC, sends only at 5am Sydney (A30) |
| chat-ai-sweep | every 2 minutes (team chat job tagging and voice transcripts, A19a) |
| read-knowledge-sweep | every 2 minutes (Knowledge Base reader, A32) |
| sync-gmail | every 5 minutes (also starts process-supplier-bills-background, A11a) |
| archive-completed-jobs | daily |
| sweep-job-booked | 13:05 and 14:05 UTC (00:05 Sydney with and without daylight saving, A6) |
| sync-overheads-nightly | daily |
| remind-client-bookings | 20:05 and 21:05 UTC, works only at 7am Sydney (bookings within 3 days with the client not told, A34) |

---

## PART B: Settings and user management

### B2. Settings tabs (current)
| Tab | Visibility |
|---|---|
| My Profile | Everyone |
| Company Details | Admin, Dev Mode |
| Xero Mapping | Admin, Dev Mode |
| Numbering | Admin |
| Quoting Defaults, Billable Rates, Inspection Checklists | Pricing roles |
| Job Defaults | Placeholder until Part F |
| Payment Terms & T&Cs (incl. Payment details) | Admin |
| Photo Categories | Everyone |
| Users & Roles, Onboarding Documents, ServiceM8 Import | Admin |
| API Keys (incl. Google Workspace, Formbay) | Admin, Dev Mode |
| Appearance | Everyone |

### B3. User management
- Built: names and roles, licences and insurance with AI expiry extraction, admin-set passwords, archived (deactivated) staff list, contract pay rates pushed to Xero (A1), HR profile (A26).
- Licence notes, update requests and expiry reminders (migration 20261103000000, 19 Oct 2026): every company licence / insurance and staff licence has a Notes field (who and when shown under it; edited on Team, the staff profile editor and Settings, My licences). Admin presses "Ask to update" on a staff licence (Team or staff profile): the employee gets a `licence` notification opening Settings with that licence highlighted, and the licence shows "Update asked" until a new expiry or file is saved. Nightly agent `sweep-licence-expiry` (00:15 Sydney): employee reminded 30, 14, 7 days before, on the day, then every 7 days while expired; a note written in the last 30 days pauses the employee's reminders; Admin gets one notification a night listing every company and staff item at a reminder point. Notes never show on the share link. Licence saves update rows in place (`saveLicenceRows`) instead of delete and re-add.
- Still open (low priority): wage history over time, industry allowances beyond the profile.

### B4. Stay logged in and Face ID (not built)
- Default supabase-js session only. Face ID via WebAuthn is possible in a PWA, not started. 2FA deliberately left out.

### B5. Custom domain (built)
- `projects.thomsonenergy.com.au` is primary (Netlify DNS, CNAME to `thomsonprojects.netlify.app`). Client links use `shareOrigin()` / `publicBaseUrl()`; server self-calls use `selfBaseUrl()` so PDFs survive a DNS fault.

---

## PART C: Payments

- **C1. Bank transfer:** bank details on invoices, reference = invoice number.
- **C2. Airwallex payment links (built):** made on demand from "Pay online" (`get-or-create-payment-link.js`); the webhook checks the HMAC, marks the invoice paid and advances the job (A6). One balance function (`get_invoice_balance_due()`). Cost ~1.65% + $0.30 per domestic payment.
- **Supplier payments (record only, migration 20261108000000):** `run-supplier-payments.js` lists approved, unpaid bills whose pay-on date is today (Sydney) or earlier, grouped by supplier, and records them paid with a date and reference (`supplier_payments` batch rows, Admin/Finance). **No Airwallex payout is built**: pay in Airwallex or by bank transfer, then Record as paid. See A11c.
- **C4. Account coding:** `xero_account_mapping` (Labour / Materials / STC, by company or individual client) gives account code and tax type per line, applied by `build-xero-invoice-payload.js`.

---

## PART D: Costing and prebuild AI

- **D1. Billable Rates (built):** rate tiers with sell rates (`billable_rate_tiers`), cost rate per staff profile. Reviewed every 6 months (A31).
- **D3. AI prebuild creation (not built):** from a description or an uploaded list, with review before save. `generate-scope.js` / `generate-sow.js` only write scope text.
- **D4. Plan takeoff and wholesaler loop (not built):** read plans into a part list, send to a wholesaler, read the quote back into costs. Needs D3.
- **D5. Profit reporting (built):** per-job GP (labour plus materials, A17) and net profit with overheads plus monthly net (A24).

---

## PART E: Client and job cards

- **E1. Client cards (not built):** `clients.html` is a list, edit form, import and ABN finder. Still to build: one hub per client with sites, jobs, quotes and invoices.
- **E1a. Client sites (built 19 Oct 2026):** `clients.address` is the office / billing address; `client_sites` (label, address, notes, one row per address per client) are the places work is done. `projects.client_address` stays the job's site address text (read everywhere on the job: header, Schedule, My Day, POs, assets, inspections, incidents, Sparky) and `projects.client_site_id` links to the saved site (null means the office address). New quote / quote edit forms show a site picker (office address, saved sites, another address; a new address is saved as a site, `attachSitePicker()` and `resolveClientSite()` in `supabase-client.js`, server twin in `_shared/client-sites.js`). Quick jobs, warranty jobs, lead jobs, email jobs, quote approval and the ServiceM8 import link the site the same way. A job save updates the client's name, email, phone and terms but never the office address; a brand new client's first site doubles as their office address until the Clients page sets it. Office address is used on the quote cover "Prepared for", the invoice Bill to block (token functions return `client_office_address`) and a newly created Xero contact (POBOX address); the "Site" rows on quotes and invoices stay the job site. Clients page: office address label, Sites list with job counts (removing a site keeps the address on its jobs).
- **E3. Materials list export by cost centre (not built):** for suppliers to price; share the export with D4.

---

## PART F: Reactive jobs workflow (not built)

Direct Job (A3) plus do-and-charge invoicing (A22) covers most of it today. Still missing: a dedicated small-jobs status flow and default checklists (Settings > Job Defaults is a placeholder).

---

## PART G: Field forms, offline, communications

- **G1. Field forms:** variations are built (A3). **SWMS, Take 5, solar and electrical inspection forms with PDFs: not built.**
- **G2. Offline support (not built):** `sw.js` only handles push. Plan: cache the app shell, IndexedDB write queue with local timestamps, sync on reconnect; start with SWMS/Take 5. Design conflicts, photo retry and slider reconciliation up front.
- **G3. SMS and calling (not built):** built after the native iPhone app, as an in-app softphone with no interim forward-to-mobile phase (decided 17 Oct 2026). See `docs/IDEAS_BACKLOG.md` item 7 and the Roadmap lead-time items.
- **G4. Push notifications:** built (A20). Not wired yet: invoice paid.

---

## PART H: Xero (live, real company)

- **H1. Connection:** Custom Connection (client_credentials), 30 minute tokens re-requested. Credentials in the `api_keys` table via `getIntegrationKey()` (xero_client_id, xero_client_secret, xero_webhook_key). Switched to the real Thomson Energy Australia company.
- **H2. Payroll:** live (A1). **Open:** confirm the Employment Hero cutover; keep EH until one full pay cycle runs clean.
- **H3. Invoicing:** invoices push as AUTHORISED; progress claims carry job context in Reference. Once pushed, corrections go through credit notes (`create-credit-note.js`, `push-credit-note-to-xero.js`, not yet tested live).
- **H4. Supplier bills to Xero (not built):** approved supplier bills are not pushed as Xero Bills.
- **H5. Division tracking category (decided 14 Oct 2026, not built):** Xero allows 2 tracking categories. Slot 1 Work Type (timesheets, built). Slot 2 **Division** from `proposal_template`: solar > Solar, new_build > New Build, renovation > Renovation, service_work and quick_estimate > Service Work, direct_job and time_and_materials > Quick Job. Tag every invoice line, credit note line and job-PO bill line; stock/vehicle POs, overheads and non-job hours stay untagged. Overheads should group by the same Division.

---

## PART I: Quote acceptance automation (Phase 1 built)

Built: see A6 (job starts at quote_approved, deposit payment advances it, completion check). Still missing:
- Pay deposit or pay in full choice on acceptance (deposit % is fixed from the quote).
- PO suggestions triggered automatically on a stage change (manual button only).
- Auto-advance to Ready to Book when every PO for the job is received.

Principle: anything that moves money or commits to a supplier stays a visible human action.

---

## PART J: Job page extras (not built)

- Actual vs Invoiced and Actual vs Estimated bar charts.
- Materials cost split by source (stock vs purchased), PO status at a glance ("3 of 4 POs received"), job-level attention flags.

---

## PART K: Solar pricing tool (not built)

In-app pricing: panels, inverters, batteries, roof type, gateway, install kits, STC deeming, recommended vs quoted price with uplift %. Pylon data (A16) is display only today.

---

## PART L: Formbay automation (not built)

Phase 1 done (A25). Still to do: Phase 2 process webhook events and pull job status and sale info; Phase 3 post settlements to Xero (accountant's method first); Phase 4 create and submit Formbay jobs (test site first). Detail in `docs/HANDOFF_formbay_stc.md`.

---

## PART M: Bugs & Updates board (open)

1. **Timesheet approval** (Tier 2): each person's manager approves their timesheets and leave; Finance and above approve all.
2. **Archive or delete superseded documents** (Tier 2, bug): duplicate signed documents clutter an employee's file.
3. **Gantt chart** (Tier 3): job windows from hours, stages and client timeline, driving scheduling and ordering; shareable.

Done since last review: clock-out cost-centre slider (A1), overheads calculator (A24).

---

## Explicitly dropped

- **ServiceM8:** dropped. Only the one-time import (A27) remains. `create-jobs.js`, `sync-costs.js` and `_servicem8.js` deleted 19 Oct 2026 (unused, no login check; `docs/BUG_REVIEW.md` S4).
- **`sales.html`:** "Coming in Phase 5" placeholder, not in the nav. Deletion candidate.
- **Employment Hero:** being replaced by the Xero Payroll push (H2).
- **TFN/super/bank in the app:** handled by Xero onboarding; old values cleared. Do not re-add.
- **`supplier-bills.html`:** removed (bypassed the stock trigger).
- Editable Word proposals; 2FA.

---

## Key principles

- Numbering is internal Postgres counters, independent of Xero.
- Run migrations before or with the deploy.
- Settings-driven values, not hardcoded.
- Credentials in `api_keys` (via `getIntegrationKey()`) or Netlify env vars, never in code.
- New tables: fast RLS (`(select auth.uid())`), one policy per action, index every FK.
- Sliders: no full re-render on drag; waterfall redistribution.
- Review before save for anything AI enters.
- Keep screens simple; small learning curve.
- "Admin can change it, the user can't" needs a BEFORE UPDATE trigger, not just RLS.
- Compress every image (`compressImage()`).

---

## Open decisions

- [ ] **Day one:** are SWMS and Take 5 needed from day one? If yes, G1 moves to Tier 1.
- [ ] **Day one:** who approves timesheets first, and is Finance's dashboard OK until M1 is built?
- [ ] Reactive jobs (Part F): formalise Direct Job, or build separately?
- [ ] Inspection forms (G1): client-facing compliance PDF, or internal only?
- [ ] Employment Hero to Xero Payroll cutover timing (H2).
- [ ] STC settlement accounting in Xero (Part L Phase 3): accountant to confirm method and GST timing.
- [ ] Wholesaler quote fallback (D4): manual pairing or flag only when a part number does not match.
- [ ] Categorise the 67 "Needs Review" materials: manual or AI with review.
- [ ] Check the auto-picked switch plate bundle ("ELRESINLSPLATE") from the SM8 import.
- [ ] Generic material swap at PO time: should prebuild components reference a material category instead of one material?
