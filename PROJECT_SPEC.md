# Thomson Projects — Build Spec

Reference doc for Thomson Energy's internal project management/quoting app (thomsonprojects.netlify.app). Save this in the repo root and update as decisions change.

**Stack:** Netlify (Git-connected deploys, serverless functions) · Supabase (Postgres, auth, storage) · Xero (Accounting API + Payroll AU API — future phase) · Anthropic API (AI extraction/generation) · Airwallex (payment links) · Twilio (SMS/calling — future phase)

**Deployment workflow:** Permanent local GitHub Desktop clone as source of truth. Each build session: edit files in place in that folder, GitHub Desktop shows the diff, commit + push, Netlify auto-deploys. **Always run Supabase migrations before or alongside the Netlify deploy** — deploying first causes clean failures, not data corruption, but still causes downtime.

**ServiceM8: dropped entirely.** No integration, no per-stage push, no SM8 buttons or functions anywhere in the app. Reactive/small jobs run through a native in-app workflow (§9, replacing old SM8 spec).

**Ordering note:** sections below are laid out roughly in the order work should happen — built/live items first, then near-term fixes, then features that depend on earlier ones, then longer-range/lower-priority items. Dependencies are called out inline where one item requires another to exist first.

---

## PART A — Built & Live

### A1. Time Tracking (built, Xero push is future phase)
- Staff log time in-app against job/stage: clock in/out tied to jobs, multi-cost-centre time split with sliders, manual entry editing, leave requests with approval workflow, staff scheduling calendar
- Employees, pay templates, payroll calendars remain configured directly in Xero
- Leave requests still go through Xero UI / Xero Me app, or the in-app leave workflow already built
- **Future phase:** app pushes timesheets to Xero Payroll AU API as `DRAFT` on a schedule (e.g. weekly); bookkeeper reviews/posts pay runs as normal; timesheet lines carry a Tracking Category (job/stage) for cost reporting — requires "Timesheet Categories" enabled under Xero Payroll Settings first

### A2. Numbering (built — foundational, no Xero dependency)
- Progress claims: sequential from **PC2000**, one global counter, not per-job
- Projects: separate 7000-series (7001, 7002...), permanent ID shown everywhere in-app
- Quotes: 1000-series · Invoices: SI3000-series
- Cost centre numbers computed as job#-position
- All sequences are atomic Postgres functions, editable in Settings
- **Key principle:** numbering is built and works independently of any Xero wiring — separation of concerns, deliberate

### A3. Proposal Templates (built)
- **New Build**: multi-stage, deposit (10% default, editable), full scope of works (AI-assisted with document upload), per-stage photo groups, T&Cs, photo category = electrical
- **Solar Proposal**: Pylon design link prominent on cover, photo category = solar
- **Quick Estimate**: single cost centre, no deposit. Requires formal sign-off, not informational only — disclaimer text editable from Settings. Invoiced from actuals, not the estimate figure.
- **Time & Materials**: single cost centre, no quote/approval step — job goes straight to booked, invoiced from actuals when done

### A4. Photo Library (built)
- Tagged by category: electrical / solar / general
- Templates only surface relevant category by default

### A5. UI Theme (built)
- **Navy Pro** — indigo-led, light background
- **Dark Trade** — charcoal background, electric blue accent
- User-level setting, saved to Supabase, persists across devices
- Toggle in Settings → Appearance, switches instantly, no reload
- Hamburger nav (replacing scrolling tab strip), mobile-first, Timesheets as mobile landing page

### A6. Job Pipeline Board (built — 10 stages)
1. **Lead** — manual entry
2. **Draft Quote** — manual
3. **Quote Approved** — auto, client accepts on-screen
4. **Deposit Paid** — auto (future: tied to Xero showing deposit paid)
5. **Ready to Book** — auto, follows deposit paid
6. **Job Booked** — manual, staff assigns dates/crew
7. **Job Not Complete** — manual flag (reason: parts/access/weather/other), logged to activity log
8. **Client Handover** — auto, final checklist/sign-off completed
9. **Awaiting Payment** — auto, final invoice generated
10. **Archived** (off board) — auto (future: tied to Xero showing invoice paid)

**Manual-only transitions:** Draft Quote, Job Booked, Job Not Complete, and Not Complete → Job Booked (never automatic)

### A7. Navigation & Branding (built)
- Logo top right of app header
- Hamburger nav: Leads · Sales · Quotes · Projects · Invoices · Purchase Orders · Timesheets
- Each tab shows a running total inline, opens a summary view (stat cards + list)
- "Projects" tab is the job pipeline board (§A6)

### A8. Favicon & Home Screen Icon (built)
- "TE" monogram mark for favicon/home screen icon
- Standard PWA icon set + manifest.json in place

### A9. Prebuilds (built — see Part D for AI generation/import additions)
- Record structure: name, internal part number, client-facing description, category/subcategory, bundle of components
- Components: labour line (hours × role/rate) or material line (item × cost)
- On a quote: pick prebuild, set quantity, every component scales automatically
- Client sees description + total price only; internal view shows full breakdown
- Editable per use without changing the master template
- Part number is internal-only, not locked to a supplier SKU
- Xero coding: labour → Labour Income account, materials → Materials/Trading Income account (future phase)
- Categories: Electrical (Lighting/Power/Trenching/Cable Runs), Solar (Panels/Batteries/Inverters), searchable/filterable

### A10. Purchase Orders — fully rebuilt (built)
- Sequential numbering from PO2000, prefix/next-number editable in Settings, same atomic-counter pattern as quotes/jobs/invoices
- Central Purchase Orders page (`purchase-orders.html`) - stats (pending, needs approval, received this month), every PO across job/Stock/vehicle destinations in one searchable list, one reliable "+ Create PO" button
- Three PO destinations: a job, Stock (general, not job-specific), or a vehicle - a vehicle PO with no supplier means pulled from Warehouse stock, not a new purchase
- Two PO types: Fixed (locked once created) and Open-ended (any staff member can add items, optional budget cap)
- Per-line-item receiving - each item ticked off individually and sent to a specific destination (Warehouse, a searched job costing straight to it, or a specific vehicle), defaulting sensibly based on the PO's own destination but always overridable
- Searchable material picker on every PO creation screen, with the option to type a brand-new item not yet in Stock at all
- Reconciliation on generic items - if a PO line was created generic and the actual invoice shows something specific, offers to update the PO's line item to match, accept or deny
- Upload invoice directly into a specific PO (photo/file), skipping supplier selection since the PO already knows it
- PO-number auto-matching - if an uploaded invoice references its own order number, auto-links instead of requiring manual selection

### A11. Supplier Invoice Upload — AI extraction (built)
- Extracts supplier name, our account number, ABN, contact details, bank details, BPAY details, our order reference (for PO auto-matching), and line items
- Hierarchical supplier matching: their account number for us > ABN > their bank details > fuzzy business name - built after real invoices showed the same account under different trading names/logos
- New supplier auto-creation with sensible defaults, editable later

### A10a. Stock locations - Warehouse + vehicles (built)
- Warehouse and each stock-holding vehicle are separate rows per material; `materials.quantity_on_hand` is a trigger-maintained total (always the sum of all locations)
- Fleet vehicles have a `holds_stock` toggle; a vehicle with it on gets its own stock page and "Create PO for this vehicle" (shed-pull vs supplier-purchase choice)
- Stock page shows Total stock cost, below-minimum count, per-material minimum quantities, a location breakdown per material, and "Suggest restock PO" for anything below minimum

### A10b. Job tasks (built)
- Tasks added at quote stage (or any time after) carry straight through to the job automatically, since a quote and its eventual job are the same underlying record
- Assignable to a specific person, a role, or left unassigned for anyone free to pick up
- Dedicated Tasks page shows assigned-to-you, assigned-to-your-role, and open tasks; a "Required before scheduling" flag exists on each task, though nothing currently blocks scheduling automatically since that hook depends on Part I's automation chain being built
- Home page "Needs attention" panel shows a count of tasks assigned to you or your role

### A10c. Universal activity log (built)
- One shared table for every entity type rather than a separate log per feature - `logActivity()` and `renderActivityLog()` are the two shared functions
- Fully instrumented: Purchase Orders (creation, per-item receiving, fully-received milestone). Partially instrumented: Jobs (PO creation and material receipt against the job), Suppliers (bill approval)
- Not yet instrumented: quotes, invoices, stock/material edits, settings changes - the shared functions make this straightforward to add when needed

### A10d. Number-first display convention (built)
- Every job/quote reference across the app now follows one consistent format via shared `projectRef()`/`projectNumberOnly()` functions: `J{jobNumber} - {name}` once a job number exists, falling back to `Q{quoteNumber} - {name}` before approval
- Matches the existing PO2000/SI3000 convention - now Q for quotes and J for jobs use the same letter-prefix pattern
- Applied to every search picker, dropdown, and label across the app (Purchase Orders, Schedule, Timesheets, Tasks, Suppliers, invoices, cost centre numbers)

### A12. Roles & Permissions (built)
| Role | Access |
|---|---|
| Admin | Everything |
| Finance | Xero-level data: invoices, payments, P&L, POs |
| Sales | Job-level pricing/quoting, no Xero/payroll |
| Staff | Jobs, notes, photos, checklists — no pricing/cost data |

- Enforced via **Supabase Row Level Security** at the database level — pricing fields must not be present in API responses to Staff logins, not just visually hidden.
- Activity log (§A13) follows the same role restrictions

### A13. Job Activity Log — not yet built
- Per-job timestamped feed: created, line item changes (old→new value), file/photo uploads, invoice generated/sent, PO created/received, variation submitted/signed, staff assigned
- Auto-populated as a side effect of using the app
- Role-restricted: Staff see the fact of an action but not $ amounts or pricing changes
- Ties into planned Twilio SMS logging (Part G) once that's built

---

## PART B — Near-Term Fixes & Settings/User Management

### B1. Known Bugs (fix)
1. **User invite email not sending** — Settings → Users shows "pending" but no invite email actually sends. Likely Supabase Auth email/SMTP config issue.
2. **Admin can't edit user names** — Settings → Users has no working update path for existing users.

### B2. Settings Restructure (planned)
- New "Admin Only" sub-category/visibility flag for settings that rarely change and shouldn't be seen by non-admin roles — at minimum Company Details and Xero Mapping; consider extending to Numbering and Payment Terms/T&Cs

**Settings categories (current + planned):**
| Category | Contains |
|---|---|
| **Company Details** *(Admin Only)* | Name, ABN, address, phone, website, licences, logo, tagline |
| **Xero Mapping** *(Admin Only, future phase)* | Account codes + tax type per line item type |
| **Numbering** | Next PC invoice, project, quote, invoice numbers |
| **Quoting Defaults** | Default markup % (45%), default deposit % (10%) |
| **Payment Terms & T&Cs** | Editable text blocks, including Quick Estimate disclaimer |
| **Payment Details** *(new — planned)* | Bank name, account name, BSB, account number — shown on invoices; payment reference auto-populated with invoice number (SI3000-series) |
| **Photo Categories** | Electrical / Solar / General — extendable |
| **Prebuild Categories** | Electrical (Lighting/Power/Trenching/Cable Runs), Solar (Panels/Batteries/Inverters) — extendable |
| **Billable Rates** *(new — planned, see Part D)* | Hourly rate tiers (Apprentice/Tradesman/Licensed Electrician/Supervisor), cost rate + sell rate each |
| **Users & Roles** | Staff accounts, role assignment |
| **Appearance** | Theme toggle (Navy Pro / Dark Trade) |

### B3. User Management Overhaul (planned)
- Fixes B1 bugs as part of this work
- Admin-generated password option, as an alternative to invite-only (for when email delivery is unreliable)
- Full user profile screen (click into a user): editable name, mobile number, industry licences + expiry, photo, notes; later: KPIs, wage/rate, industry allowances (travel, tool, leading hand, etc.)
- Each user tagged with a billable rate tier (see Part D)

### B4. Auth Persistence & Biometric Login (new — planned)
- **Stay logged in:** persist Supabase Auth refresh token locally so staff aren't prompted for username/password every time they open the app — only on token expiry, explicit logout, or reinstall
- **Face ID / biometric unlock:** achievable in a PWA via the **WebAuthn API** (supported by iOS Safari and Android Chrome's platform authenticators) — not a native-app-only feature. Flow: staff log in once with username/password, then opt in to "enable Face ID"; subsequent app opens prompt the device's biometric authenticator instead of a login form, tied to the persisted Supabase session
- 2FA considered and explicitly left out for now — not required by Xero (Xero connection is machine-to-machine, client_credentials grant, no human login involved) and adds friction that isn't currently wanted

### B5. Custom Domain — projects.thomsonenergy.com.au (new — planned, no extra cost)
- Point the existing thomsonenergy.com.au domain at the app via a subdomain, replacing thomsonprojects.netlify.app
- **No additional cost** — custom domains/subdomains are free on Netlify's standard hosting, and the domain itself is already owned/paid for
- **Setup:** Netlify → Domain management → add `projects.thomsonenergy.com.au` → Netlify provides a CNAME target → add that CNAME record in the domain's existing DNS settings → Netlify auto-issues SSL
- **Does not affect** existing email (MX records) or the main website (root domain A/CNAME records) — entirely separate DNS record
- **Sequencing note:** best done before webhook-dependent integrations (Xero, Airwallex, Twilio — Parts C, H, G3) are wired up, since webhook URLs are registered against a specific domain and would need updating if changed after the fact

---

## PART C — Payments

### C1. Payment Details & Bank Transfer (built)
- Settings → Payment Details: bank name, account name, BSB, account number, shown on invoices
- Invoice payment reference auto-populated with the invoice number (SI3000-series)

### C2. Airwallex Payment Links (built)
- **Decision:** Airwallex chosen over Stripe because Thomson Energy banks with Airwallex — funds settle directly into the existing account rather than a separate payout relationship
- Payment link generated on-demand when the client clicks "Pay online" on their invoice link, via `get-or-create-payment-link.js`
- Webhook verifies HMAC signature, marks the invoice paid on `payment_link.paid`
- Single-source balance calculation (`get_invoice_balance_due()`) avoids GST drift between client-side and server-side totals
- Supplier payments run the other direction - `run-supplier-payments.js` batches a supplier's due bills into one transfer, triggered manually ("Run payments due today"), never auto-executed - Airwallex's own maker-checker approval gate is the real safety net regardless of how the transfer gets created
- **Cost:** ~1.65% + $0.30 per paid transaction (domestic), no cost for the link itself; Explore plan is $0/month if $5k+ deposits/balance maintained, else $29/month

### C3. Supplier Invoice Upload — AI Extraction (built)
- See A11 for full detail - built and working, including PO-number auto-matching and the generic-item reconciliation flow
- Not yet built: pushing the finalized bill to Xero as a Bill (depends on Xero being wired up, Part H)


### C4. Tax & Account Coding per Line Item (future phase, when Xero wired up)
- `TaxType` toggle per line: GST on Income / GST Free Income / BAS Excluded
- `AccountCode` per line item, mapped from a locked lookup table (line item type → correct Xero account code + valid tax types), so mismatched combinations can't be pushed
- Example: STC credits code to a separate income account from standard Service Income
- **Action needed:** confirm actual Xero chart-of-accounts codes with bookkeeper before building the mapping table

---

## PART D — Labour Costing, Materials Database & Prebuild AI (sizeable, likely its own build phase)

**Dependency order within this part:** D1 (billable rates) and D2 (materials database) need to exist before D3 (prebuild AI generation) or D4 (takeoff/wholesaler loop) can work, since the AI needs something concrete to match components against.

### D1. Billable Rates (planned)
- Settings → Billable Rates: hourly rate tiers (e.g. Apprentice, Tradesman, Licensed Electrician, Supervisor), each with a cost rate (what's paid) and sell rate (what's billed)
- Each staff user profile (§B3) tagged with their applicable rate tier
- Jobs automatically roll up logged timesheet hours × rate into a running labour cost per job/stage, in real time (not just at invoice time)
- "Labour" becomes its own selectable line item type in the quote builder and invoice — hours × sell rate — integrated with the existing markup/cost-centre structure

### D2. Materials Database (planned)
- New table: material name, cost price, sell price, category, supplier
- Populated/updated automatically when a PO is uploaded (ties into A10 PO tracker) or when a supplier price list is uploaded (AI extraction, same pattern as C3)
- Materials selectable as quote/invoice line items alongside labour and prebuilds
- **Prebuilds (A9) to be refactored** to reference this materials database as their backing table, rather than storing standalone cost/material lines

### D3. AI-Assisted Prebuild Creation (new — planned)
- **From a text description:** describe the prebuild (e.g. "8W downlight install with plug base and 10m cable run") and the AI:
  - Generates an internal part number following the existing numbering convention
  - Writes the client-facing description (the line item text customers see)
  - Breaks it into labour components (hours × rate tier, from D1) and material components (from D2, or flags new materials to add)
  - Populates the prebuild record for review — not auto-saved; pricing/scope on a reusable template needs a check before it goes live
- **From an uploaded document:** upload an existing prebuild list (spreadsheet, doc, whatever format currently exists) and the AI reads it, extracts the same structure, and builds prebuild records from it
  - **Style/tone control:** a style guide can be given up front (e.g. "short and plain, no jargon" vs "full spec detail") so generated client-facing text matches house style rather than mirroring the source document
  - Same review-before-save principle — bulk import without a check screen risks propagating errors across many prebuilds at once
- Both entry points (short prompt vs uploaded document) feed the same underlying AI extraction/generation engine and output shape — one function, two inputs, not two separate features

### D4. Plan-Reading Takeoff & Wholesaler Quote Loop (new — planned)
- When AI reads a plan/spec document as part of prebuild generation (D3) or scope-of-works generation (A3):
  - **No specific part number given** (e.g. plan just says "downlights throughout"): AI specs a generic/standard item from the existing prebuild or materials database default
  - **Specific part number given** (e.g. a named brand/SKU called out in the plan): AI uses that exact part in the prebuild, **and** adds it to a **takeoff list** — a consolidated list of every specific part number required across the whole plan, with quantities, formatted ready to send to a wholesaler for pricing
- **Wholesaler quote comes back** → upload it → AI reads it, matches each line to the part numbers from the takeoff list, and updates the cost price on the corresponding prebuild/material entries
- **Review/confirm screen required** before price updates save, consistent with C3's principle
- **Open decision:** if a wholesaler's line doesn't match a part number exactly (different SKU format, slight description mismatch), does the review screen allow manual pairing to the right database row, or just flag "no match found"? Needs a fallback either way — to be decided at build time
- Specific parts need to exist in (or be added to) the Materials Database (D2) — same table, not a separate parts list
- This is a third input mode for the same AI extraction engine as D3: plan document in → prebuild + takeoff out; wholesaler quote in → price updates out

### D5. Cost/Profit Reporting (decided approach — simplified)
- **No per-job overhead allocation.** Considered allocating monthly overhead to jobs by share of labour hours, but decided against it — added complexity for a number that's still just an estimate, and delays when a job's profit figure is "final" pending month-end data.
- **Per-job gross profit only:** revenue − direct labour − direct materials, quoted vs actual, with labour margin vs materials margin split visible. This is the job-level dashboard number.
- **Separate net P&L, run monthly at business level:** total revenue and total overhead pulled from Xero P&L for the period (future phase, once Xero wired up) — answers "is the business profitable overall," kept separate from job-level figures.
- Job expenses (materials/POs) still tracked per job via Purchase Orders (A10)

---

## PART E — Client, Quote & Job Card Overhaul (new — planned)

**Design goal for this part: keep it simple and easy to learn** — small learning curve is a stated priority, not just a nice-to-have.

### E1. Client Cards (new — planned)
- Each client card shows, in one place:
  - Client address
  - List of all site addresses associated with that client (a client may have multiple properties/sites)
  - List of job numbers associated with the client
  - List of quotes associated with the client
  - List of invoices associated with the client
- Effectively a client-level hub — click through from any of these lists into the actual quote/job/invoice record

### E2. Quote & Job Cards — Tabbed Layout (new — planned)
- Quote cards and job cards get a consistent tabbed interface, e.g.:
  - **Notes** tab
  - **Scope of Works (SOW)** tab
  - **Cost Centres** tab
- Clicking into a Cost Centre shows its breakdown: labour components and material components for that cost centre specifically (not the whole job at once)
- Keeps each view focused and uncluttered — supports the small-learning-curve goal by not showing everything at once

### E3. Materials List Export by Cost Centre (new — planned)
- At any time, download a full materials list for an entire job, split by cost centre
- Purpose: send directly to suppliers for quoting/pricing — same underlying need as the takeoff list in D4, but at the job level rather than the plan-reading stage
- Should reuse the same export/formatting logic as D4's takeoff list where possible, rather than building a second, separate export feature

---

## PART F — Reactive Jobs Workflow (native — replaces dropped ServiceM8 integration)

*Still to design/build. Placeholder for whatever replaces the old SM8 per-stage push flow for reactive/small jobs.*
- Needs: job creation, status flow, materials/checklist handling, invoicing — all in-app, no external system
- **Open decision:** how closely should this mirror the staged-project pipeline (A6) vs a lighter simplified flow?

---

## PART G — Field Forms, Offline Support & Communications (longer-range)

### G1. Field Forms (with digital signature capture) — not yet built
- **SWMS** — task/hazard/control/PPE breakdown, plant/equipment used, each worker signs on site, re-signable per day for multi-day jobs
- **Take 5** — 5 prompts (stop/look/assess/control/monitor), optional photo, single sign-off, done fresh per shift
- **Variation Form** — description, reason, cost impact (labour/materials/markup/new total), sign-off on-screen or sent as client link, locks and feeds into job's running cost total once signed
- **Solar Inspection** — array/inverter/isolator/earthing checks, compliance photo checklist, pass/fail, inspector signature
- **Electrical Inspection** — switchboard/RCD/circuit checks, compliance photo checklist, pass/fail, inspector signature
- **Open decision:** do inspection forms auto-generate a client-facing compliance certificate PDF, or stay internal-only?
- Submitted forms auto-generate a clean PDF for the job record/compliance file

### G2. Offline Support (revisited — now planned, was previously deferred)
- **Decision reversed:** originally deferred as "not worth the complexity at this stage" — now confirmed as necessary for field use and added to the roadmap so the rest of the build doesn't make it harder to retrofit later
- **Core pattern (standard PWA offline architecture):**
  - Service worker caches the app shell so the app loads with no connection
  - IndexedDB as a local write queue — photos, files, notes, timesheet entries save locally first (tagged "pending sync"), shown in the UI immediately, given a local temp ID until synced
  - Background sync / reconnect-triggered flush pushes the queue to Supabase once signal returns
- **Known hard parts to design for up front, not bolt on later:**
  - Photo/file uploads need chunking + retry logic for patchy (not just fully offline) connections — common in the field
  - Conflict handling needed if two staff edit the same job while both offline (simplest: last-write-wins, but can silently overwrite notes — needs a deliberate decision, not a default)
  - Timesheet clock in/out must timestamp at the moment of the local action, not at sync time
  - Complex UI state (e.g. multi-cost-centre sliders) needs to work fully against local data and reconcile on sync — more involved than a simple form queue
- **Scoped rollout, not all-at-once:** Phase 1 = build the offline queue/sync infrastructure and prove it via SWMS/Take 5 forms (self-contained, no live data dependencies, lowest risk) before extending to notes, photos, and timesheets
- **Implication for current build:** new features (photos, files, notes, timesheets, forms) should be built with this local-queue pattern in mind from the start where practical, to avoid a costly retrofit

### G3. SMS & Calling (Twilio) — new, future phase
- Existing Twilio account/number in use (currently routed through ServiceM8's call setup) — to be brought in-house into Thomson Projects directly, not via Twilio Flex (Flex is a full separate contact-centre product, ~£90/user/month, with its own UI outside the app — unnecessary given the existing Twilio account and in-house build approach)
- **SMS:** inbound/outbound texts via Twilio Messaging API + Netlify webhook function; messages logged to a table tied to client/job, visible and sendable by any logged-in staff member from within the app; ties into Job Activity Log (A13)
- **Calling — multi-user shared number:**
  - Simplest option: Twilio `<Dial>` with multiple numbers/`client:` identities rings all available staff simultaneously, first to answer connects (no separate routing engine needed)
  - Fuller option: Twilio Voice SDK embedded as an in-app softphone (access token per staff member) for calls handled entirely inside the app rather than bridged to personal mobiles
  - Call logs (duration, timestamp, staff member) recorded against client/job automatically
- Credentials (Account SID, Auth Token) stored as Netlify env vars, same pattern as other integrations
- Suggested build order: SMS first (simplest, immediate value) → shared-number simultaneous ring (click-to-call/bridge, low complexity) → full in-app softphone (highest complexity, lowest priority)

### G4. Push Notifications & Badge Count (new — planned)
- **Home screen widgets are not possible for a PWA on iOS** — WidgetKit is native-app-only, Apple doesn't expose it to web apps. Ruled out unless the app is ever wrapped/rebuilt as a native iOS app (a materially bigger undertaking, not currently planned).
- **Push notifications:** iOS has supported Web Push for home-screen PWAs since iOS 16.4, Android Chrome has long supported it — realistic "at-a-glance" alternative to widgets
  - Trigger on events like: new SMS received (ties into G3 Twilio SMS), lead assigned, quote approved, invoice paid, job flagged "Not Complete"
  - Needs a push subscription registered per device (Web Push API) and a Netlify function to send notifications on the relevant app events
- **Badge count on the home screen icon:** via the Badging API (supported in iOS/Android PWA mode) — shows unread count (e.g. unread SMS messages) directly on the app icon without opening the app
  - Ties directly into G3's SMS inbox — badge count = unread messages, clears when opened/read
- Both features build on the same underlying event triggers as the Job Activity Log (A13) and SMS (G3), so should be sequenced alongside or after those rather than as a standalone earlier build

---

## PART H — Xero Integration (future phase, wired up last)

### H1. Xero Connection
- Custom Connection (machine-to-machine, client_credentials grant) — correct for a single-org internal tool; no human login involved, so Xero's 2FA policies for human users don't apply here
- Granular scopes required (not broad legacy scopes): invoices, contacts, accounts, payroll/timesheets AU, tracking categories
- Tokens: 30-minute expiry, re-request rather than refresh
- Timesheet Categories must be enabled in Xero UI before API work
- Credentials stored as Netlify environment variables
- **Recommended sequence:** numbering (done) → invoice UI against DB → wire Xero push last

### H2. Payroll
- Drop Employment Hero; push timesheets directly to Xero Payroll AU API
- **Open decision:** confirm actual current status of Employment Hero cutover with bookkeeper — don't drop EH until Xero payroll push is tested and working

### H3. Invoicing to Xero
- Staged projects invoiced from the app directly to Xero's Invoices API
- Progress claim invoices carry job context in Reference field (see A2 numbering)

### H4. Cost/Profit Dashboard (Xero-dependent extension of D5)
- Pull labour actuals from Xero Payroll, job expenses from Xero Accounting API filtered by Tracking Category
- Compared against app's own quote line items → quoted vs actual vs profit
- Feeds into the net P&L view described in D5

---

## PART I — Quote Acceptance → Job Automation Chain (new — planned, not yet built)

**Vision:** once a client accepts a quote on their link, the job should progress through the pipeline largely on its own, with manual scheduling still always available as an override.

**Step 1 — Accept → choose → pay**
- Client accepts on their token-based link (existing `accept_quote` RPC)
- A popup asks: pay the deposit, or pay in full
- Whichever is chosen, a real invoice is created for that amount **from the client's own link** — needs a new public/token-safe function, since existing invoice creation is staff-only and authenticated
- Job number is drawn at this point (already the existing trigger point - see §2 numbering)
- Client is shown a payment page for that exact invoice: pay online (Airwallex), or pay by bank transfer

**Step 2 — Payment confirmed → Deposit Paid**
- Extend the existing Airwallex webhook (already marks invoices paid) to also auto-advance the job's pipeline stage to Deposit Paid once that invoice clears

**Step 3 — Deposit Paid → PO suggestion + notify the quoter**
- Reuse the existing "Generate PO suggestions from quote" logic (already built on the job page), but trigger it automatically on entering Deposit Paid rather than requiring a manual click
- Surface this to whoever originally quoted the job - no notifications system exists yet; likely extends the existing Home page "Needs attention" panel (already built for overdue invoices etc.) rather than a new system
- Quoter reviews the suggested POs and sends them out (still a human action, not automatic)

**Step 4 — All POs received → Ready to Book**
- Once every PO for that job is marked fully received (existing per-line-item receiving system), auto-advance the pipeline stage to Ready to Book
- Manual scheduling remains available at any point regardless of stage - this is an accelerant, not a lock

**Key principle carried through:** every step that involves money or committing to a supplier stays a real, visible action a human can see and, where relevant, click - automation moves the job forward, it doesn't hide what happened.

**Dependencies:** Step 1 is the foundation everything else builds on (needs the new client-facing invoice-creation function). Steps 2-4 are each fairly small once Step 1 exists, since they're mostly "watch for X, then flip pipeline stage to Y" logic on top of features already built.

---

## PART J — Quote/Job Page Redesign (planned, not yet built)

**Vision:** replace the current long-scrolling single page with a tabbed layout, taking inspiration from SimPro's structure (screenshots reviewed) but adapted to what this app already has.

**Tabs:** Summary (default) / Cost Centres / Purchase Orders / Details (client quote link + CCEW)

**Summary tab content depends on job status:**
- Still a quote (no job number yet) - pie chart (Materials / Labour / Profit split from the quoted estimate) + estimate breakdown table
- Has a job number - two bar charts (Actual vs Invoiced, Actual vs Estimated) using real quoted-vs-actual data already tracked (billable rates + `job_material_usage`), plus a breakdown table with Actual and Estimate side by side
- Persistent Activity/Timeline panel on the right side of every tab, pulling from the existing `activity_log`

**Agreed improvements beyond a straight SimPro copy**, since this app has data SimPro's version doesn't:
- Materials cost split by source (from existing stock vs newly purchased) using `job_material_usage.source`
- PO status shown directly on Summary ("3 of 4 POs fully received", "$2,400 still pending") - an at-a-glance scheduling-readiness signal
- Reuse the existing labour-cost budget bar pattern instead of introducing a new generic bar chart style, for visual consistency
- Job-level "needs attention" flags (tasks outstanding, bills needing approval, POs not received) surfaced on Summary
- Role-aware by default - Staff see progress/status without dollar figures, matching existing pricing-role restrictions elsewhere

**Cost Centres tab:** same idea, scoped to one stage - its own charts/breakdown plus Parts & Labour for that stage specifically.

## PART K — Site Inspection & Solar Pricing/Design (open, not yet scoped)

Two related but distinct ideas raised together, neither built or fully scoped yet:

**Site inspection checklist on quotes:**
- A toggle on the quote: "does this need a site inspection?"
- If yes, reveals a configurable set of inspection questions/photo requirements
- Reference material reviewed: Runbase (a solar-specific quoting tool) screenshots showing conditional logic (Yes/No answers dynamically show/hide subsequent requirements), mandatory photo checklists with progress tracking, AI photo analysis (e.g. switchboard analysis), and property/owner details feeding STC/REC registry requirements
- **Explicitly not a straight copy** - Runbase's checklist is solar-specific and the business does both electrical and solar work, so this needs its own scoping session to define what's actually needed, not a port of someone else's questions

**Solar pricing/design tool + Pylon integration:**
- Runbase reference also showed an in-house pricing tool (panels/inverters/batteries with quantities, roof type, gateway, install kits, STC deeming year/month, recommended vs quoted sale price with uplift %)
- Stated goal: price within this app, use Pylon only for the technical design/calculations and panel layout (Pylon is currently just a reference link on the solar proposal template - client clicks through to view the interactive design, no data flows back)
- **Open question, needs real research before any commitment:** does Pylon expose an API that can return panel/inverter/battery counts or layout data programmatically? This determines whether "price here, design in Pylon" is achievable via integration or would require rebuilding pricing logic independently of whatever Pylon produces
- Not scoped further pending that research and a dedicated design session

## Explicitly Dropped
- **ServiceM8** — dropped entirely, not just for staged jobs. All SM8 buttons/functions removed. Replaced by native Reactive Jobs workflow (Part F, still to design).
- **Employment Hero** — dropped, timesheets push directly to Xero Payroll AU API instead (see H2 for cutover confirmation caveat).
- Editable Word doc proposal workflow — decided against, unnecessary complexity.
- 2FA — considered when discussing auth persistence; explicitly left out for now (see B4).

---

## Key Principles
- **Separation of concerns for numbering:** Project/job/quote/invoice numbers are internal Postgres sequences with no Xero dependency — built and working independently of any Xero wiring.
- **Deploy sequencing matters:** Always run Supabase migrations before or alongside Netlify deploys.
- **Settings-driven configuration:** Key values (numbering starts, disclaimer text, markup defaults, etc.) editable from Settings rather than hardcoded.
- **API keys and credentials** stored as Netlify environment variables or in the Supabase database — never hardcoded.
- **Drag performance:** avoid re-rendering entire components on every drag event; waterfall redistribution model for multi-slider panels (multi-cost-centre time/quote sliders).
- **Review before save:** any AI-driven data entry (supplier invoice extraction, prebuild generation/import, wholesaler quote price updates) requires a review/confirm screen — no blind auto-save, since errors would otherwise propagate silently.
- **Simplicity as a design goal:** client/quote/job card overhaul (Part E) is explicitly meant to keep a small learning curve — favour focused, tabbed views over dense all-at-once screens.
- **Build order matters for dependent features:** e.g. Billable Rates + Materials Database (D1/D2) must exist before AI Prebuild Generation (D3) or Takeoff/Wholesaler matching (D4) can work.

---

## Open Decisions
- [ ] Reactive Jobs workflow (Part F): how closely should it mirror the staged pipeline vs a lighter flow?
- [ ] Inspection forms (G1): auto-generate client-facing compliance PDF, or internal-only?
- [ ] Confirm Xero chart-of-accounts codes for each income category with bookkeeper (C4)
- [ ] Confirm Employment Hero → Xero Payroll cutover timing (H2) — don't drop EH until Xero payroll push is tested and working
- [ ] Wholesaler quote matching fallback (D4): manual pairing option, or flag-only, when a line doesn't match a part number exactly?
- [ ] Site inspection checklist (Part K): what questions/photos does this business actually need, given both electrical and solar work - not a straight port of the Runbase reference
- [ ] Pylon API research (Part K): does it expose panel/inverter/battery/layout data programmatically, which determines whether "price here, design in Pylon" is achievable
