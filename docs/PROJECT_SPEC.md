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
- Manual only: draft_quote, job_not_complete and Not Complete back to Booked.
- **Job Booked gate (migration 20261023000000):** a job is only **job_booked** while someone is scheduled to it (a job booking today or later) or clocked into it now. A booking or clock-in moves Ready to Book to Job Booked; removing or moving the last booking moves it back (to Awaiting Action if required tasks are open); clocking out does not (the clock-out "How's the job?" step decides). Quick Job, Warranty Job and ServiceM8 imports start at Ready to Book. Moving a job to Job Booked by hand with nobody scheduled or clocked in is refused. A booking that slips into the past is only re-checked when something on the job changes (no nightly sweep).

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
- `check_status`: matches, problems, no_po, queried, resolved. Matches + PO received = approved for payment automatically. The PO "fully received" approval now only approves bills that matched or were accepted (it used to approve every linked bill).
- Problems: **Query supplier** drafts an email listing each difference; a person edits and presses Send. Sent from invoice@ via sales@ (needs the "Send mail as" setting, `docs/EXTERNAL_ACCOUNTS.md`). The reply links back to the bill. **Accept as is** with a reason.
- Statements: emailed ones (bill reader's statements, plus "statement" emails in sales@) read automatically; uploads on a supplier page still work and are reconciled on the server too. Two-way check (`_shared/statement-intake.js`): missing bills (one-tap email asking for copies), amounts that differ, invoice listed twice on the statement, bill entered twice in TEops, our unpaid bills not on the statement, bills with problems or no PO, balance vs our unpaid total. Payments and credits on the statement are ignored for matching.
- Missing statements: from the 10th, suppliers that billed us last month with no statement since (one-tap "Ask for a statement").
- **Bill checks page** (`supplier-checks.html`, Admin/Finance/Sales): To approve, Problems, Statements, Missing statements. `statement` push to Admin and Finance. Worker `statements` (hourly at :30) reports to the ops manager; the digest lists bills to approve, problems, statements not reconciling, missing statements and queries waiting on suppliers.

### A12. Stock locations
- Warehouse plus each `holds_stock` vehicle as separate rows; `materials.quantity_on_hand` is a trigger-kept total. Stock page: total cost, minimums, location breakdown, "Suggest restock PO". Vehicle stock pages.

### A13. Job tasks
- Added at quote stage or later; assign to a person, a role or anyone. Tasks page; Home "Needs attention" count.
- **"Required before scheduling" is enforced** on every Schedule entry point and drives awaiting_action (A6).
- Take photo on any task (open the task): saved as a site photo captioned "#task <task>" (`project_photos.task_id`), thumbnails and count on the task. Ticked tasks show who ticked them and when.

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
- Tabs: Summary · Cost Centres · Purchase Orders · Variations · Invoices · STCs · Details · Feed · Emails · Documents · Site Photos, plus the Activity sidebar.
- Summary: stat cards, budget bars, "Quoted split" and "Job split" donuts, "On this job now".
- Labour cost everywhere (job page, Projects list, timesheet drilldown, warranty cost) is wages plus **direct** overhead (each person's direct rate from Overheads, company average for the estimate). Underneath, pricing roles see "incl. overheads $X", which adds **indirect** overhead (plus company overhead on the cost tiles for Finance and Admin). Labour budget % is worked out server-side in `get-accrued-labour-cost.js` so Staff see the same % as Sales (they cannot read `estimated_labour_cost`).
- Cost centre cards show labour plus materials quoted vs actual and GP%.

### A18. Sales inbox and My inbox (Gmail)
- `inbox.html`: toggle **Sales inbox** (sales@, every staff member) | **My inbox** (the logged-in person's own work Gmail, private to them). Migration 20261021020000 (`mailboxes`, `mailbox_tokens`, labels, drafts, sender rules, clean up, Gmail notice).
- `sync-gmail.js` every 5 minutes (sales@ first, then each My inbox from Gmail history, including read and archive changes made in Gmail), Sync now via `sync-gmail-now.js`. HTML viewer, inline pictures, attachments.
- Sections sorted by the email agent (`_shared/email-agent.js`, run by `mailbox-work-background.js`): **Priority** (someone waiting on our reply, with a one-line reason; drops off once we reply), **Other**, **Subscriptions and updates**, plus Sent, Done, All. Order: the person's "always for this sender" rule, Gmail's Promotions/Social/Updates/Forums tabs and unsubscribe headers, then Claude Haiku 5.5. Move any conversation; Done archives (in Gmail too).
- Labels (Gmail style) for non-job matters (a supplier dispute, a licence application): sidebar with counts, Open or Finished, description tells the agent what belongs. The agent applies existing labels and suggests new ones (a person confirms). Sales inbox labels are shared, My inbox labels are private. Mirrored to Gmail as `TEops/<name>`.
- Jobs: the agent tags when sure ("tagged by Sparky", dashed, one tap to remove) and suggests when guessing. Tagged conversations show on the job for everyone, including from My inbox; untagged My inbox mail stays private.
- Drafts: the agent (Claude Opus 5.5) drafts replies to Priority mail from the last 7 days, with [gaps] for facts it doesn't have. Draft shows at the bottom of its conversation and in the **Drafts** list (top right, with a count), and in Gmail drafts. Nothing sends without a person pressing Send.
- **Clean up** (sidebar): scans the whole Gmail inbox however far back by sender (count, unread, unsubscribe link), the agent suggests Archive / Worth a look / Keep per sender (clients always Worth a look), then one tap archives, marks read or unsubscribes (one-click link or unsubscribe email) a whole sender. Also "mark everything older than N days as read". Nothing is deleted.
- My inbox connect: anyone, from Inbox > My inbox. A Workplace Surveillance Act 2005 (NSW) notice pops up first: "I agree and waive the 14 days notice" connects now; "I don't agree" locks Connect for 14 days from the notice (checked on the server, `gmail_connect_allowed_from()`). Recorded in `gmail_connect_notices`. Loads the last 60 days, then new mail. Disconnect removes private mail from TEops, keeps job-tagged conversations.
- Reply and compose with attachments (My inbox replies go from the person's own address, signature shows that address); tag conversations to jobs; Emails tab on every job with "Email the client" (a reply there to someone else's My inbox conversation goes from sales@ as a new email).
- Create a quote or job from an email (AI reads client, site and work).
- Signatures show sales@thomsonenergy.com.au (or the person's own address from My inbox) and 0455 415 464.
- Gmail permission: gmail.modify + gmail.send. sales@ must be connected once more in Settings for labels, drafts, Done and Clean up to reach Gmail; until then they stay in TEops only.

### A19. Feeds, meetings, job extras
- Company feed and per-job feed (likes, comments, tags).
- Meetings: record, transcribe, analyse; follow-up tasks with reminders.
- Installer summary on the job card; recent jobs for the same client; search within a job.

### A19a. Team chat (migration 20261020000000, live 18 Oct 2026)
- Chat page (`chat.html`, `js/chat.js`, `css/chat.css`) and a chat icon with unread count in the top bar. Replaces WhatsApp.
- Channels: General and Social for everyone; admins make more (everyone or chosen people), rename, archive. DMs: one to one or groups up to 12, anyone can start.
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
- **Policy versions and consent** (migration 20261018120000): onboarding documents have a version and an optional type (Policy, AI consent, Location consent). Settings > Onboarding "Publish new version" makes everyone re-sign; `policy-update.html` is shown on login to anyone who finished onboarding but has an unsigned current version ("Remind me later" once per login or day, then a banner). Consent forms need I agree / I don't agree plus a signature; the answer sets `profiles.ai_consent_at` / `location_consent_at` by trigger (staff cannot edit them directly). My Profile has on/off switches (off is instant via `withdraw_consent()`, on means signing again); the staff editor shows versions signed and consent. Optional documents (Required unticked) no longer block onboarding. Shared signing panel: `public/js/document-signing.js`.

### A27. ServiceM8 import (one-time cutover)
- `sm8-import.html` (Settings > ServiceM8 Import, admin) via `sm8-import-preview.js`, `sm8-import-jobs.js`, `sm8-import-lines.js` (migration 153). Dry run, then imports open Work Order jobs; keeps the SM8 job number; skips jobs already imported, so it can be re-run.
- Jobs with a value import as `new_build` (so "Invoice project" bills the balance), others as Direct Jobs. One stage per job with SM8 line items: bundles as prebuild groups, standalone lines marked Labour/Material, paced for SM8's ~180 calls/minute.
- Lettered SM8 jobs (e.g. 4515A deposit) count toward invoiced to date.
- STC lines are not applied: listed in the job notes and `projects.sm8_stcs` (migration 155), offered prefilled on the STCs tab.
- `sm8-copy-attachments-background.js` (migration 154 `sm8_attachment_copies`): pictures to Photos, other files to Documents > "ServiceM8", with retries. Starts by itself after Import.
- Labour and checklists (same background run, `_shared/sm8-labour.js`, migration 20261021000000): each recorded SM8 check-in becomes a time entry on the job for the matched person, marked already paid (`xero_pushed_at`), shown on the job only (hidden from Timesheets, staff KPIs, timesheet problems, never pushed to Xero). Every checklist item, ticked or not, becomes an unassigned onsite task. Staff matched on the import page (`sm8-staff.js`, `profiles.sm8_staff_uuid`); unmatched staff's time is skipped and listed in the run summary (`sm8_copy_runs`). Re-runs never double up. Lettered jobs (4515A-D) are folded in: their time, checklists, docs and photos land on the main job.
- Copy details (migration 20261021010000): AVIF photos and videos go to Photos (videos play in place), files already in Documents are moved on the next run. Photos and documents keep ServiceM8's date and the matched person who added them. Checklist groups become a task each with the items as subtasks (who ticked, when, reminder as due date and assignee). The run summary keeps a few raw ServiceM8 checklist records to check field names.
- ServiceM8 invoice PDFs (file name has "invoice") go to the "ServiceM8 invoices" folder, listed under "From ServiceM8" on the job's Invoices tab and hidden from Documents. Reference only: not `invoices` rows, so no Xero push and no change to invoiced to date. Each has a Delete button. "Partial Invoice #..." PDFs (ServiceM8's internal copy of each claim line) are not brought across; ones already copied are removed on the next run.
- File size: no bucket has its own limit, so Supabase's project-wide limit applies (Storage > Settings, default 50 MB). SM8 videos over it fail with "The object exceeded the maximum allowed size"; raise it to 500 MB and press the copy button again (failed files are retried).

### A28. Other built features
- **Leads and call requests** from the website forms (`leads.html`), converted to quotes or jobs.
- **Site inspections** (migration 104): "Needs a site visit" on a lead, quote or job; checklist filled on site (`site-inspection.html`); templates in Settings > Inspection Checklists.
- **Customer assets** with warranty and service reminders (`assets.html`).
- **Licence sharing:** a live link to a chosen set of company and employee licences (`share-licences.html`); licences and insurance with AI-extracted expiry on the Team page.
- **Knowledge base** with OCR for scanned PDFs, **Tech Support** numbers, **Team**, **DNSP**, **Fleet**, **Bugs & Updates** board (synced to `BUGS_AND_UPDATES.md` by `sync-bugs-to-repo.js`).

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

### A29. Scheduled functions (netlify.toml)
| Function | Schedule |
|---|---|
| send-notifications | every minute |
| warm-pdf | every 4 minutes |
| ops-digest | 18:00 and 19:00 UTC, sends only at 5am Sydney (A30) |
| chat-ai-sweep | every 2 minutes (team chat job tagging and voice transcripts, A19a) |
| sync-gmail | every 5 minutes (also starts process-supplier-bills-background, A11a) |
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

- **D1. Billable Rates (built):** rate tiers with sell rates (`billable_rate_tiers`), cost rate per staff profile. Reviewed every 6 months (A31).
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
