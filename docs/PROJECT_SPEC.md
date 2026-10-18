# TEops (Thomson Projects): Build Spec

Last verified against code: 17 Oct 2026

Internal operations app for Thomson Energy Australia (electrical and solar contractor). Live at projects.thomsonenergy.com.au, with thomsonprojects.netlify.app kept as a working backup. The code is the source of truth: if this file and the code disagree, fix this file.

**Stack:** Netlify (Git-connected deploys, serverless and scheduled functions) · Supabase (Postgres, auth, storage) · Xero (Accounting API + Payroll AU API, **live**, real company) · Anthropic API (AI extraction, generation, assistant) · AssemblyAI (meeting transcription) · Airwallex (client payment links) · Gmail API (shared sales@ inbox, **live**) · Web Push (phone notifications, **live**) · Pylon (solar design, pull and push) · Formbay (STCs, webhook receiver only so far) · ABR (ABN lookup).

**Credentials:** integration keys live in the Supabase `api_keys` table, edited in Settings > API Keys, and are read server-side with `getIntegrationKey()` (`netlify/functions/_shared/get-integration-key.js`; it falls back to a `<NAME>_API_KEY` env var only if no row exists). Keys in use: anthropic, assemblyai, abr_guid, airwallex_client_id / api_key / webhook_secret, xero_client_id / client_secret / webhook_key, google_client_id / client_secret / refresh_token, pylon, formbay, formbay_webhook_secret, vapid_public_key / private_key, servicem8 (import only). Only platform secrets stay as Netlify env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEV_MODE_PASSWORD`, `GITHUB_TOKEN` (bugs sync), `CLAUDE_AGENT_KEY` (agent comments), `PDF_KEEP_BROWSER` (optional).

**Deployment:** edit in the local GitHub clone, commit and push, Netlify auto-deploys. **Run Supabase migrations before or alongside the deploy.** Bump the `?v=` on any edited JS/CSS (10 minute cache). Latest migration: 155.

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
6. **One full dry run with a real job:** quote, email it, accept and sign from the link, check the job lands at quote_approved, pay the deposit, check it moves to Awaiting Action or Ready to Book, schedule, clock in and out (slider), invoice, push to Xero, pay, check PAID. Fix anything that breaks before anyone depends on it.
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

---

## PART A: Built and live

### A1. Time tracking and payroll
- Clock in/out against job and stage from My Day; manual entries; leave requests with approval; staff scheduling calendar.
- **Clock-out cost-centre slider** (`cko-split-slider` in `public/js/supabase-client.js`): split the shift's hours across stages at clock-out, waterfall redistribution. Closed variations drop out of the list; do-and-charge variations can take time.
- **Who's clocked in:** "Clocked in now" card on Schedule and Team, "On this job now" with clock in/out/switch on a job's Summary (migration 147, `get_active_clock_ins`).
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
- Templates (`proposal_template`): **new_build** (multi-stage, deposit 10% default, AI scope of works, T&Cs), **solar** (Pylon design data on the cover, solar compliance check `check-solar-compliance.js`, solar task generation), **renovation**, **service_work**, **quick_estimate** (single cost centre, no deposit, signed, invoiced from actuals, Schedule of Rates page, migration 140).
- **Direct Job** (`direct_job`): "+ New job (no quote)", goes straight to a job, invoiced from actuals with do-and-charge lines (A22). `time_and_materials` is the legacy equivalent.
- Client signs the quote on screen to accept it (migration 144). "Prepared by" on the cover and investment page (migration 140).
- **Variations:** fixed-price (quoted, emailed, signed by the client, added to the job; migration 143) and do-and-charge (log hours, add Stock and prebuilds, each becomes its own stage and is claimed like any other; migration 142). Signed variations remake the quote PDFs and file the old one as legacy.

### A4. Photo library
- Tagged electrical / solar / general; templates surface the relevant category. Every upload goes through `compressImage()`.

### A5. Look and feel
- TEops wordmark, animated wiring background on login and home. Themes Navy Pro and Dark Trade (per user, saved to Supabase; dark by default on touch devices). No sideways page scroll; global search.

### A6. Job pipeline (14 stages, migration 112)
- lead, draft_quote, quote_sent, quote_approved, deposit_paid, awaiting_action, ready_to_book, job_booked, job_not_complete, client_handover, ready_to_invoice, awaiting_payment, complete, archived. Board is `dashboard.html` ("Job pipeline").
- **Pipeline automation Phase 1:** accepting a quote runs `create-job-from-quote.js`, which creates the job at **quote_approved** and raises the deposit invoice (`is_deposit`). When the deposit is paid, the Airwallex and Xero webhooks move it on (`_shared/advance-job-stage.js`): to **awaiting_action** if any required-before-scheduling task is open, otherwise **ready_to_book**. No deposit needed: it moves on straight away. Later payments check for **complete**.
- `archive-completed-jobs.js` (daily) moves jobs at complete for more than 2 days to archived.
- Manual only: draft_quote, job_booked, job_not_complete and Not Complete back to Booked.

### A7. Navigation
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
- `purchase-orders.html`: every PO for a job, Stock or a vehicle (vehicle PO with no supplier = pulled from the Warehouse). Fixed or Open-ended (optional budget cap).
- Per-line receiving to Warehouse, a job or a vehicle; searchable material picker; generic-to-specific line reconciliation; invoice upload straight onto a PO; PO-number auto-matching. One shared supplier search-or-create picker on every PO surface.
- "Generate PO suggestions from quote" button on the job page (manual).

### A11. Supplier invoice upload (AI extraction)
- Supplier, our account number, ABN, contacts, bank/BPAY, order reference and lines. Supplier matching: account number > ABN > bank details > fuzzy name; auto-creates new suppliers. Bills can be approved for payment.

### A12. Stock locations
- Warehouse plus each `holds_stock` vehicle as separate rows; `materials.quantity_on_hand` is a trigger-kept total. Stock page: total cost, minimums, location breakdown, "Suggest restock PO". Vehicle stock pages.

### A13. Job tasks
- Added at quote stage or later; assign to a person, a role or anyone. Tasks page; Home "Needs attention" count.
- **"Required before scheduling" is enforced** on every Schedule entry point and drives awaiting_action (A6).

### A13a. Activity log
- One `activity_log` table (`logActivity()` / `renderActivityLog()`), shown as a sidebar on the job page. Covers POs, jobs/quotes (stage edits), invoices, suppliers, materials, clients, tasks, documents, variations, timesheets. Not yet: settings changes, schedule changes.

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
- Tabs: Summary · Cost Centres · Purchase Orders · Variations · Invoices · STCs · Details · Feed · Emails · Documents · Site Photos, plus the Activity sidebar.
- Summary: stat cards, budget bars, "Quoted split" and "Job split" donuts, "On this job now". Cost tiles include overheads for Finance and Admin (`get_project_overheads`).
- Cost centre cards show labour plus materials quoted vs actual and GP%.

### A18. Shared inbox (sales@ Gmail)
- `sync-gmail.js` every 5 minutes, Sync now via `sync-gmail-now.js`. HTML viewer, inline pictures, attachments, Inbox / Sent / All.
- Reply and compose with attachments; tag conversations to jobs; Emails tab on every job with "Email the client".
- Create a quote or job from an email (AI reads client, site and work).
- Signatures always show sales@thomsonenergy.com.au and 0455 415 464.

### A19. Feeds, meetings, job extras
- Company feed and per-job feed (likes, comments, tags).
- Meetings: record, transcribe, analyse; follow-up tasks with reminders.
- Installer summary on the job card; recent jobs for the same client; search within a job.

### A20. Notifications
- Bell plus Web Push to phones (per device, app badge), per-type switches. `send-notifications.js` runs every minute.
- Types: tagged, comments, tasks, task reminders, meeting follow-ups, schedule bookings, new emails, reviews, call reminders.
- Website "Book a call" requests: up for grabs on Home; claiming moves it to **Your calls** (Done / Release) with a reminder 5 minutes before.

### A21. Reviews
- "Ask for a review" when emailing a client; no-account review page (stars, comment, optional Google link). Reviews page with average, filters, copy for website.

### A22. Quote and invoice documents
- Quote: A4 proposal pages (cover, project, scope, investment summary, photos, schedule of rates for estimates, T&Cs); header on every page but the cover.
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
- **Letters** (`letter.html`, migration 148): warning and counselling letters signed in the app by manager and employee, with active period and resolution.
- Onboarding: staff enter their details, which fill their employment contract (rates and start date from Settings); contracts flip to signed when signed (migration 149).

### A27. ServiceM8 import (one-time cutover)
- `sm8-import.html` (Settings > ServiceM8 Import, admin) via `sm8-import-preview.js`, `sm8-import-jobs.js`, `sm8-import-lines.js` (migration 153). Dry run, then imports open Work Order jobs; keeps the SM8 job number; skips jobs already imported, so it can be re-run.
- Jobs with a value import as `new_build` (so "Invoice project" bills the balance), others as Direct Jobs. One stage per job with SM8 line items: bundles as prebuild groups, standalone lines marked Labour/Material, paced for SM8's ~180 calls/minute.
- Lettered SM8 jobs (e.g. 4515A deposit) count toward invoiced to date.
- STC lines are not applied: listed in the job notes and `projects.sm8_stcs` (migration 155), offered prefilled on the STCs tab.
- `sm8-copy-attachments-background.js` (migration 154 `sm8_attachment_copies`): pictures to Photos, other files to Documents > "ServiceM8", with retries.

### A28. Other built features
- **Leads and call requests** from the website forms (`leads.html`), converted to quotes or jobs.
- **Site inspections** (migration 104): "Needs a site visit" on a lead, quote or job; checklist filled on site (`site-inspection.html`); templates in Settings > Inspection Checklists.
- **Customer assets** with warranty and service reminders (`assets.html`).
- **Licence sharing:** a live link to a chosen set of company and employee licences (`share-licences.html`); licences and insurance with AI-extracted expiry on the Team page.
- **Knowledge base** with OCR for scanned PDFs, **Tech Support** numbers, **Team**, **DNSP**, **Fleet**, **Bugs & Updates** board (synced to `BUGS_AND_UPDATES.md` by `sync-bugs-to-repo.js`).

### A29. Scheduled functions (netlify.toml)
| Function | Schedule |
|---|---|
| send-notifications | every minute |
| warm-pdf | every 4 minutes |
| sync-gmail | every 5 minutes |
| archive-completed-jobs | daily |
| sync-overheads-nightly | daily |

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
- Still open (low priority): wage history over time, industry allowances beyond the profile.

### B4. Stay logged in and Face ID (not built)
- Default supabase-js session only. Face ID via WebAuthn is possible in a PWA, not started. 2FA deliberately left out.

### B5. Custom domain (built)
- `projects.thomsonenergy.com.au` is primary (Netlify DNS, CNAME to `thomsonprojects.netlify.app`). Client links use `shareOrigin()` / `publicBaseUrl()`; server self-calls use `selfBaseUrl()` so PDFs survive a DNS fault.

---

## PART C: Payments

- **C1. Bank transfer:** bank details on invoices, reference = invoice number.
- **C2. Airwallex payment links (built):** made on demand from "Pay online" (`get-or-create-payment-link.js`); the webhook checks the HMAC, marks the invoice paid and advances the job (A6). One balance function (`get_invoice_balance_due()`). Cost ~1.65% + $0.30 per domestic payment.
- **Supplier payments (preview only):** `run-supplier-payments.js` lists approved, unpaid bills due, grouped by supplier. **No Airwallex payout is built**: the confirm step returns "not available yet". Pay suppliers manually.
- **C4. Account coding:** `xero_account_mapping` (Labour / Materials / STC, by company or individual client) gives account code and tax type per line, applied by `build-xero-invoice-payload.js`.

---

## PART D: Costing and prebuild AI

- **D1. Billable Rates (built):** rate tiers with sell rates (`billable_rate_tiers`), cost rate per staff profile.
- **D3. AI prebuild creation (not built):** from a description or an uploaded list, with review before save. `generate-scope.js` / `generate-sow.js` only write scope text.
- **D4. Plan takeoff and wholesaler loop (not built):** read plans into a part list, send to a wholesaler, read the quote back into costs. Needs D3.
- **D5. Profit reporting (built):** per-job GP (labour plus materials, A17) and net profit with overheads plus monthly net (A24).

---

## PART E: Client and job cards

- **E1. Client cards (not built):** `clients.html` is a list, edit form, import and ABN finder. Still to build: one hub per client with sites, jobs, quotes and invoices.
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

- **ServiceM8:** dropped. Only the one-time import (A27) remains. **Deletion candidates:** `create-jobs.js`, `sync-costs.js` and `_servicem8.js` are still deployed but nothing calls them.
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
