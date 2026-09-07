# Thomson Projects — Build Spec

Reference doc for Thomson Energy's internal project management/quoting app (thomsonprojects.netlify.app). Save this in the repo root and update as decisions change.

**Stack:** Netlify (Git-connected deploys, serverless functions) · Supabase (Postgres, auth, storage) · Xero (Accounting API + Payroll AU API — **live**) · Anthropic API (AI extraction/generation) · Airwallex (payment links) · Twilio (SMS/calling — future phase)

**Deployment workflow:** Permanent local GitHub Desktop clone as source of truth. Each build session: edit files in place in that folder, GitHub Desktop shows the diff, commit + push, Netlify auto-deploys. **Always run Supabase migrations before or alongside the Netlify deploy** — deploying first causes clean failures, not data corruption, but still causes downtime.

**ServiceM8: dropped entirely.** No integration, no per-stage push, no SM8 buttons or functions anywhere in the app. Reactive/small jobs run through a native in-app workflow (§Part F, still to design — Quick Job/Time & Materials currently stands in for it).

**TFN/super/bank: dropped from the app entirely.** New/existing employees' tax file number, superannuation details, and bank account details are no longer collected or stored anywhere in Thomson Projects. That data now goes through Xero's own native new-employee onboarding instead — the app's onboarding flow still collects date of birth, address, and emergency contact, and tells staff to expect a direct invite from Xero for the rest. All previously-stored TFN/super/bank values were cleared from the database when this changed.

**Ordering note:** sections below are laid out roughly in the order work should happen — built/live items first, then near-term fixes, then features that depend on earlier ones, then longer-range/lower-priority items. Dependencies are called out inline where one item requires another to exist first.

---

## PART A — Built & Live

### A1. Time Tracking & Payroll (built, Xero push live)
- Staff log time in-app against job/stage: clock in/out tied to jobs, multi-cost-centre time split with sliders, manual entry editing, leave requests with approval workflow, staff scheduling calendar
- Timesheets can't overlap — clocking into one job for a time window blocks selecting that same window on another job; the conflicting entry must be edited or deleted first
- At least one cost centre must be selected per entry — no unlabelled time
- **Admin/Finance timesheet dashboard:** every staff member's timesheets in one place, editable by Finance/Admin, shows lunch breaks taken and flags any day over 6 hours with no break recorded
- Employees are asked about their break when creating/editing a timesheet entry, same pattern as clock in/out
- **Xero push (live):** timesheets push to Xero Payroll AU on demand, split by Tracking Category — Billable (Jobs) / Non-billable (Office) / Training (TAFE), not per-job. Xero's 100-option cap per tracking category made per-job tracking unworkable at real volume.
- Ordinary/OT1/OT2/Public Holiday hour bands each map to their own Xero earnings rate (Settings → Xero Mapping)
- **Living Away From Home Allowance (LAHA):** a job/quote more than ~100km from base can be flagged "LAHA approved"; clocking out of a LAHA-approved job asks whether the employee stayed overnight, and confirmed nights push as a separate LAHA earnings line to Xero (once per day per project)
- Employees, pay templates, and payroll calendars remain configured directly in Xero
- Leave requests go through Xero UI / Xero Me app, or the in-app leave workflow already built
- **Open:** confirm current Employment Hero cutover status with bookkeeper — don't drop EH until the Xero payroll push has been running cleanly for a full pay cycle (see H2)

### A2. Numbering (built — foundational, no Xero dependency)
- Progress claims: sequential from **PC2000**, one global counter, not per-job
- Projects: separate 7000-series (7001, 7002...), permanent ID shown everywhere in-app
- Quotes: 1000-series · Invoices: SI3000-series · Purchase Orders: PO2000-series
- Cost centre numbers computed as job#-position
- All sequences are atomic Postgres functions, editable in Settings
- **Key principle:** numbering is built and works independently of any Xero wiring — separation of concerns, deliberate

### A3. Proposal Templates (built)
- **New Build**: multi-stage, deposit (10% default, editable), full scope of works (AI-assisted with document upload), per-stage photo groups, T&Cs, photo category = electrical
- **Solar Proposal**: Pylon design link prominent on cover, photo category = solar, live Pylon panel/inverter/battery data pull (see A16)
- **Quick Estimate**: single cost centre, no deposit. Requires formal sign-off, not informational only — disclaimer text editable from Settings. Invoiced from actuals, not the estimate figure.
- **Time & Materials / Quick Job**: single cost centre, no quote/approval step — job goes straight to booked, invoiced from actuals when done. Currently doubles as the de-facto Reactive Jobs entry point (see Part F) via the "+ New job (no quote)" button on the clock-in screen.

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
4. **Deposit Paid** — auto (currently: not wired to auto-advance on payment — see Part I)
5. **Ready to Book** — auto, follows deposit paid
6. **Job Booked** — manual, staff assigns dates/crew
7. **Job Not Complete** — manual flag (reason: parts/access/weather/other), logged to activity log
8. **Client Handover** — auto, final checklist/sign-off completed
9. **Awaiting Payment** — auto, final invoice generated
10. **Archived** (off board) — auto (future: tied to Xero showing invoice paid)

**Manual-only transitions:** Draft Quote, Job Booked, Job Not Complete, and Not Complete → Job Booked (never automatic)

**Known divergence:** a quote accepted via the client link currently creates its job straight at **Job Booked**, skipping stages 3–5 entirely — see Part I for detail. Needs a decision on whether that's intentional or should be fixed to step through the board.

### A7. Navigation & Branding (built)
- Logo top right of app header
- Hamburger nav: Leads · Sales · Quotes · Projects · Invoices · Purchase Orders · Timesheets
- Each tab shows a running total inline, opens a summary view (stat cards + list)
- "Projects" tab is the job pipeline board (§A6)

### A8. Favicon & Home Screen Icon (built)
- "TE" monogram mark for favicon/home screen icon
- Standard PWA icon set + manifest.json in place

### A9. Prebuilds (built)
- Record structure: name, internal part number, client-facing description, category/subcategory, bundle of components
- Components: labour line (hours × role/rate) or material line (item × cost) — **not yet linked to the Materials Database (A9a)**, prebuild material lines are still standalone, not `material_id` references
- On a quote: pick prebuild, set quantity, every component scales automatically
- Client sees description + total price only; internal view shows full breakdown
- Editable per use without changing the master template
- Part number is internal-only, not locked to a supplier SKU
- Xero coding: labour → Labour Income account, materials → Materials/Trading Income account, via the live `xero_account_mapping` table (see C4)
- Categories: Electrical (Lighting/Power/Trenching/Cable Runs), Solar (Panels/Batteries/Inverters), searchable/filterable
- **Not yet built:** AI-assisted prebuild generation from a text description or uploaded document — see D3

### A9a. Materials Database (built)
- Standalone `materials` table — name, category, supplier, cost price, sell price, quantity on hand — distinct from Prebuilds
- Populated/updated via AI extraction from an uploaded supplier price list (`extract-pricelist.js`), same pattern as the PO invoice extraction in A11
- Materials selectable as quote/invoice line items
- **Remaining:** Prebuilds (A9) should be refactored to reference this table for their material components rather than storing standalone lines; per-job gross profit (D5) still needs to roll this cost in

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
- **Consistent everywhere:** every PO-creation surface (Purchase Orders page, job page, Stock page, vehicle stock page) shares the same supplier search-or-create picker and invoice-upload helper — uploading an invoice against a new PO auto-creates the supplier if one doesn't already match (by account number, ABN, bank details, or fuzzy business name)

### A11. Supplier Invoice Upload — AI extraction (built)
- Extracts supplier name, our account number, ABN, contact details, bank details, BPAY details, our order reference (for PO auto-matching), and line items
- Hierarchical supplier matching: their account number for us > ABN > their bank details > fuzzy business name - built after real invoices showed the same account under different trading names/logos
- New supplier auto-creation with sensible defaults, editable later
- **Not yet built:** pushing the finalized bill to Xero as a Bill

### A12. Stock locations - Warehouse + vehicles (built)
- Warehouse and each stock-holding vehicle are separate rows per material; `materials.quantity_on_hand` is a trigger-maintained total (always the sum of all locations)
- Fleet vehicles have a `holds_stock` toggle; a vehicle with it on gets its own stock page and "Create PO for this vehicle" (shed-pull vs supplier-purchase choice)
- Stock page shows Total stock cost, below-minimum count, per-material minimum quantities, a location breakdown per material, and "Suggest restock PO" for anything below minimum
- Note: the old standalone `supplier-bills.html` page was removed entirely — it was an orphaned dead-end that bypassed this trigger-based stock system by writing `quantity_on_hand` directly

### A13. Job Tasks (built)
- Tasks added at quote stage (or any time after) carry straight through to the job automatically, since a quote and its eventual job are the same underlying record
- Assignable to a specific person, a role, or left unassigned for anyone free to pick up
- Dedicated Tasks page shows assigned-to-you, assigned-to-your-role, and open tasks
- **"Required before scheduling" flag is enforced**, not just cosmetic — a job with an incomplete required task can't be dragged, mobile-added, or manually added to the Schedule; every entry point checks and blocks with a clear message
- Home page "Needs attention" panel shows a count of tasks assigned to you or your role

### A13a. Universal Activity Log (built)
- One shared table for every entity type rather than a separate log per feature - `logActivity()` and `renderActivityLog()` are the two shared functions
- Fully instrumented: Purchase Orders (creation, per-item receiving, fully-received milestone). Partially instrumented: Jobs (PO creation and material receipt against the job), Suppliers (bill approval)
- Not yet instrumented: quotes, invoices, stock/material edits, settings changes - the shared functions make this straightforward to add when needed
- Shown as a persistent sidebar alongside every tab on the job page (see A17)

### A13b. Number-first display convention (built)
- Every job/quote reference across the app follows one consistent format via shared `projectRef()`/`projectNumberOnly()` functions: `J{jobNumber} - {name}` once a job number exists, falling back to `Q{quoteNumber} - {name}` before approval
- Matches the existing PO2000/SI3000 convention - now Q for quotes and J for jobs use the same letter-prefix pattern
- Applied to every search picker, dropdown, and label across the app

### A14. Roles & Permissions (built)
| Role | Access |
|---|---|
| Admin | Everything |
| Finance | Xero-level data: invoices, payments, P&L, POs, admin timesheet dashboard |
| Sales | Job-level pricing/quoting, Schedule editing, no Xero/payroll |
| Staff | Jobs, notes, photos, checklists, own timesheets — no pricing/cost data, read-only Schedule |

- Enforced via **Supabase Row Level Security** at the database level — pricing fields must not be present in API responses to Staff logins, not just visually hidden
- **Security hardening (built):** a BEFORE UPDATE trigger on `profiles` blocks a user from changing their own role (or any other admin-controlled field) via a direct API call — column-level GRANTs alone can't express "admin can change this, the user themself can't," so this needed a trigger, not just RLS
- Schedule page is fully role-gated: only Admin/Finance/Sales can drag/resize/create/delete blocks; Staff get a genuine read-only day view instead of a raw permission-denied error after the fact
- Activity log follows the same role restrictions

### A15. Job Activity Log — see A13a
*(merged into A13a above — kept as one item since they're the same feature)*

### A16. Pylon Integration (built)
- Live pull of panel/inverter/battery counts and hardware summary from Pylon's `solar_designs` API, stored on the project and shown on the solar quote page
- Still reference-only for design — Pylon remains the place the actual technical design/layout happens; this just surfaces its output inside the app rather than requiring a click-through (see Part K for the still-unbuilt in-app pricing tool)

### A17. Job Page — Tabbed Layout (built)
- `project.html` already has the tabbed structure originally planned in Part J: **Summary / Cost Centres / Purchase Orders / Invoices / Details / Documents**, with a persistent Activity/Timeline sidebar visible alongside every tab
- Summary tab shows stat cards and progress/budget bars for labour cost vs budget
- **Not yet built:** the pie/bar chart visuals originally envisioned (Materials/Labour/Profit split, Actual-vs-Invoiced, Actual-vs-Estimated) — current Summary tab is numeric cards and bars, not charts. See Part J.

---

## PART B — Near-Term Fixes & Settings/User Management

### B1. ~~Known Bugs~~ (fixed)
1. ~~User invite email not sending~~ — `invite-user.js` calls Supabase Auth's real invite-email function; working.
2. ~~Admin can't edit user names~~ — Settings → Users profile panel has a working update path.

### B2. Settings Restructure (still planned)
- New "Admin Only" sub-category/visibility flag for settings that rarely change and shouldn't be seen by non-admin roles — at minimum Company Details and Xero Mapping; consider extending to Numbering and Payment Terms/T&Cs
- Not yet built — Settings currently has no such visibility flag

**Settings categories (current + planned):**
| Category | Contains |
|---|---|
| **Company Details** *(planned: Admin Only)* | Name, ABN, address, phone, website, licences, logo, tagline |
| **Xero Mapping** *(planned: Admin Only)* | Account codes + tax type per line item type — built and live, just not yet visibility-restricted |
| **Numbering** | Next PC invoice, project, quote, invoice, PO numbers |
| **Quoting Defaults** | Default markup %, default deposit % |
| **Payment Terms & T&Cs** | Editable text blocks, including Quick Estimate disclaimer |
| **Payment Details** | Bank name, account name, BSB, account number — shown on invoices; payment reference auto-populated with invoice number |
| **Photo Categories** | Electrical / Solar / General — extendable |
| **Prebuild Categories** | Electrical (Lighting/Power/Trenching/Cable Runs), Solar (Panels/Batteries/Inverters) — extendable |
| **Billable Rates** | Hourly rate tiers, cost rate + sell rate each — built (see D1) |
| **Users & Roles** | Staff accounts, role assignment, licence/insurance tracking with AI-extracted expiry dates |
| **Appearance** | Theme toggle (Navy Pro / Dark Trade) |

### B3. User Management (mostly built)
- Admin-editable user names/roles — built (B1)
- Full user profile: licences + expiry, insurance docs — **built**, including AI extraction of type/reference/expiry from an uploaded certificate
- **Still open:** admin-generated password option as an alternative to invite-only; KPIs, wage/rate history, industry allowances (travel, tool, leading hand, etc.) beyond what's already on the profile

### B4. Auth Persistence & Biometric Login (not built)
- **Stay logged in:** no persisted-session handling beyond default supabase-js behaviour — still prompts for login on the normal token-expiry/logout schedule, nothing extra engineered
- **Face ID / biometric unlock:** not started — no WebAuthn code anywhere. Achievable in a PWA via the **WebAuthn API** (supported by iOS Safari and Android Chrome's platform authenticators), not a native-app-only feature
- 2FA still explicitly left out — not required by Xero (machine-to-machine connection, no human login involved) and adds friction that isn't currently wanted

### B5. Custom Domain — projects.thomsonenergy.com.au (not built)
- Still on `thomsonprojects.netlify.app` — no custom domain configured in `netlify.toml` or DNS
- **No additional cost** — custom domains/subdomains are free on Netlify's standard hosting, and the domain itself is already owned/paid for
- **Setup:** Netlify → Domain management → add `projects.thomsonenergy.com.au` → Netlify provides a CNAME target → add that CNAME record in the domain's existing DNS settings → Netlify auto-issues SSL
- **Does not affect** existing email (MX records) or the main website (root domain A/CNAME records) — entirely separate DNS record
- **Sequencing note:** best done before any further webhook-dependent integrations (Twilio — Part G) are wired up, since webhook URLs are registered against a specific domain

---

## PART C — Payments (built)

### C1. Payment Details & Bank Transfer (built)
- Settings → Payment Details: bank name, account name, BSB, account number, shown on invoices
- Invoice payment reference auto-populated with the invoice number (SI3000-series)

### C2. Airwallex Payment Links (built)
- **Decision:** Airwallex chosen over Stripe because Thomson Energy banks with Airwallex — funds settle directly into the existing account rather than a separate payout relationship
- Payment link generated on-demand when the client clicks "Pay online" on their invoice link, via `get-or-create-payment-link.js`
- Webhook verifies HMAC signature, marks the invoice paid on `payment_link.paid` — **does not currently advance the job's pipeline stage**, see Part I
- Single-source balance calculation (`get_invoice_balance_due()`) avoids GST drift between client-side and server-side totals
- Supplier payments run the other direction - `run-supplier-payments.js` gives a **read-only preview** of a supplier's due bills grouped by supplier; actually creating the transfer via Airwallex's payout API is deliberately **not built** — moving real money without the ability to test against a live response wasn't worth the risk. Manual payment remains the process for now.
- **Cost:** ~1.65% + $0.30 per paid transaction (domestic), no cost for the link itself; Explore plan is $0/month if $5k+ deposits/balance maintained, else $29/month

### C3. Supplier Invoice Upload — AI Extraction (built)
- See A11 for full detail

### C4. Tax & Account Coding per Line Item (built)
- Live `xero_account_mapping` table: line item type (Labour / Materials / STC, split by company vs individual client type) → `xero_account_code` + `xero_tax_type`, applied per line by `build-xero-invoice-payload.js` — not hardcoded, mismatched combinations can't be pushed

---

## PART D — Labour Costing, Materials Database & Prebuild AI

### D1. Billable Rates (built)
- Settings → Billable Rates: hourly rate tiers, each with a sell rate (`billable_rate_tiers` table); per-staff cost rate lives on the profile
- Each staff user profile tagged with their applicable rate tier
- "Labour" is a selectable line item type in the quote builder and invoice — hours × sell rate

### D2. Materials Database (built — see A9a)
*(merged into A9a above — kept as one item since they're the same feature)*

### D3. AI-Assisted Prebuild Creation (not built)
- **From a text description:** describe the prebuild and have AI generate the part number, client-facing description, and labour/material component breakdown for review — not built. `generate-scope.js`/`generate-sow.js` exist for scope-of-works text generation, but nothing generates a Prebuild record.
- **From an uploaded document:** upload an existing prebuild list and have AI extract the same structure — not built
- Same review-before-save principle would apply once built — no blind auto-save on AI-generated pricing data

### D4. Plan-Reading Takeoff & Wholesaler Quote Loop (not built)
- Reading a plan/spec document to generate a takeoff list of specific part numbers + quantities, sending it to a wholesaler, then reading the quote back to update prebuild/material costs — none of this exists yet
- Depends on D2 (done) and D3 (not done) — the AI needs prebuild-generation capability to plug into first

### D5. Cost/Profit Reporting (decided approach, partially built)
- **No per-job overhead allocation** — decided against, stays a business-level-only concern (see H4)
- **Per-job gross profit — not yet combining labour + materials.** The job page currently shows labour cost vs budget per cost centre; a stale in-code comment still says "full gross profit needs materials cost too, once the materials database exists" — the materials database now exists (A9a), so this is now just a wiring gap, not a data gap. Revenue − direct labour − direct materials, quoted vs actual, with labour margin vs materials margin split, is the target.
- **Separate net P&L, run monthly at business level:** still depends on H4 (Xero P&L pull), not built
- Job expenses (materials/POs) already tracked per job via Purchase Orders (A10)

---

## PART E — Client, Quote & Job Card Overhaul

**Design goal for this part: keep it simple and easy to learn** — small learning curve is a stated priority, not just a nice-to-have.

### E1. Client Cards (not built)
- `clients.html` today is a searchable list + edit form only — no client-level hub
- Still to build: each client card showing site addresses, associated job numbers, quotes, and invoices all in one place, click-through into each

### E2. Quote & Job Cards — Tabbed Layout (mostly built — see A17)
- The job page tabbed layout envisioned here is already built (Summary / Cost Centres / Purchase Orders / Invoices / Details / Documents + persistent Activity sidebar) — see A17 for current state and what's still missing (charts)
- **Gap vs original vision:** no dedicated "Notes" tab — notes/SOW live in their own section rather than a tab
- Cost Centres tab already shows per-cost-centre labour breakdown; materials breakdown blocked on the same D5 gap

### E3. Materials List Export by Cost Centre (not built)
- Download a full materials list for an entire job, split by cost centre, formatted to send to suppliers for pricing
- Should reuse the same export/formatting logic as D4's takeoff list once that exists, rather than building a second separate export feature

---

## PART F — Reactive Jobs Workflow (not built — native, replaces dropped ServiceM8 integration)

*Still to design/build.* The **Time & Materials / Quick Job** template (A3) currently stands in for this — jobs without a quote can already be created and invoiced from actuals — but there's no dedicated reactive-jobs workflow distinct from the staged pipeline yet. Settings still has a placeholder note ("default checklist items will be set here once the Reactive Jobs workflow is built").
- Needs: job creation, status flow, materials/checklist handling, invoicing — all in-app, no external system
- **Open decision:** how closely should this mirror the staged-project pipeline (A6) vs a lighter simplified flow? Given Quick Job already covers a lot of the ground, does this become "formalize Quick Job into its own workflow" rather than a from-scratch build? (See also the Bugs & Updates board item requesting exactly this — Quick Job rebuilt as pure time-and-materials billing with standalone invoice creation retired in its favour.)

---

## PART G — Field Forms, Offline Support & Communications

### G1. Field Forms (with digital signature capture) — partially built
- **Variation Form** — **built**: description, reason, cost impact, on-screen digital signature capture (canvas signature pad), saves and locks into the job's running cost total once signed
- **SWMS, Take 5, Solar Inspection, Electrical Inspection — not built.** No matching code anywhere yet.
- **Open decision:** do inspection forms auto-generate a client-facing compliance certificate PDF, or stay internal-only?
- Submitted forms should auto-generate a clean PDF for the job record/compliance file — not yet built for any form type

### G2. Offline Support (not built)
- No service worker, no IndexedDB write queue, no offline caching anywhere in the app yet
- **Core pattern (standard PWA offline architecture), still the plan:**
  - Service worker caches the app shell so the app loads with no connection
  - IndexedDB as a local write queue — photos, files, notes, timesheet entries save locally first (tagged "pending sync"), shown in the UI immediately, given a local temp ID until synced
  - Background sync / reconnect-triggered flush pushes the queue to Supabase once signal returns
- **Known hard parts to design for up front, not bolt on later:** photo/file chunking + retry for patchy connections; conflict handling for two staff editing the same job while both offline (needs a deliberate decision, not a default last-write-wins); timesheet clock in/out must timestamp at the moment of the local action, not sync time; multi-cost-centre sliders need to work fully against local data and reconcile on sync
- **Scoped rollout, not all-at-once:** Phase 1 = build the offline queue/sync infrastructure and prove it via SWMS/Take 5 forms (once G1 has them) before extending to notes, photos, timesheets
- **Implication for current build:** new features should keep this local-queue pattern in mind where practical, to avoid a costly retrofit later

### G3. SMS & Calling (Twilio) — not built
- No Twilio integration anywhere in the codebase yet
- Existing Twilio account/number in use (currently routed through ServiceM8's call setup) — to be brought in-house directly, not via Twilio Flex
- **SMS:** inbound/outbound texts via Twilio Messaging API + Netlify webhook function; messages logged to a table tied to client/job, visible/sendable by any logged-in staff member; ties into Activity Log (A13a)
- **Calling — multi-user shared number:** simplest is Twilio `<Dial>` ringing all available staff simultaneously; fuller option is the Twilio Voice SDK as an in-app softphone
- Suggested build order: SMS first → shared-number simultaneous ring → full in-app softphone

### G4. Push Notifications & Badge Count (not built)
- Home screen widgets ruled out for iOS PWA (WidgetKit is native-app-only)
- **Push notifications:** iOS has supported Web Push for home-screen PWAs since iOS 16.4, Android Chrome long-standing support — needs a push subscription per device (Web Push API) and a Netlify function to send on relevant events (new SMS, lead assigned, quote approved, invoice paid, job flagged Not Complete)
- **Badge count:** via the Badging API, ties into G3's SMS inbox once built
- Should be sequenced alongside or after A13a (Activity Log) and G3 (SMS), not as a standalone earlier build

---

## PART H — Xero Integration (built & live)

### H1. Xero Connection (built)
- Custom Connection (machine-to-machine, client_credentials grant) — correct for a single-org internal tool; no human login involved, so Xero's 2FA policies for human users don't apply here
- Granular scopes: invoices, contacts, accounts, payroll/timesheets AU, tracking categories
- Tokens: 30-minute expiry, re-request rather than refresh
- Timesheet Categories enabled in Xero Payroll Settings (required before the timesheet push worked — a real gotcha hit during build, see Key Principles)
- Credentials stored as Netlify environment variables

### H2. Payroll (built, EH cutover still to confirm)
- Timesheets push to Xero Payroll AU API — **live**, tracking-category split (A1), LAHA earnings line included
- **Open decision:** confirm actual current status of Employment Hero cutover with bookkeeper — don't drop EH until the Xero payroll push has been proven stable over a full pay cycle

### H3. Invoicing to Xero (built)
- Staged projects and Time & Materials jobs invoiced from the app directly to Xero's Invoices API
- Progress claim invoices carry job context in the Reference field
- **New invoices push as Approved (AUTHORISED status)**, not Draft — bookkeeper wanted them ready-to-go, not needing a manual approve step in Xero every time
- Editing an already-pushed invoice re-sends via `update-invoice-in-xero.js`, preserving whatever status Xero already has it at

### H4. Cost/Profit Dashboard (Xero-dependent extension of D5) — not built
- Pull labour actuals from Xero Payroll, job expenses from Xero Accounting API filtered by Tracking Category
- Compared against app's own quote line items → quoted vs actual vs profit
- Feeds into the net P&L view described in D5

---

## PART I — Quote Acceptance → Job Automation Chain (partially built — diverges from original vision)

**Original vision:** once a client accepts a quote, the job progresses through the pipeline (Quote Approved → Deposit Paid → Ready to Book) largely on its own, with manual scheduling always available as an override.

**What's actually built today:**
- `accept-quote.js` + `create-job-from-quote.js`: accepting a quote on the client's token-based link **already auto-creates the job and auto-raises a real, token-safe deposit invoice** server-side — more automated on this specific point than the original plan assumed (which expected a new public function would still need to be built for this)
- **Divergence:** the new job is inserted straight at **Job Booked**, skipping Quote Approved / Deposit Paid / Ready to Book entirely — those stages exist on the board but this path doesn't step through them
- **Not built:** the "pay deposit vs pay in full" choice popup — deposit % is currently fixed from the quote, no in-the-moment choice offered
- **Not built:** the Airwallex webhook does not advance pipeline stage on payment — it only marks the invoice paid (see C2)
- **Manual, not automatic:** "Generate PO suggestions from quote" exists and works, but only via a button click on the job page — not auto-triggered on entering any particular stage
- **Not built:** no auto-advance to Ready to Book when all POs for a job are fully received

**Open decision (new):** should the auto-created job be changed to step through Quote Approved → Deposit Paid → Ready to Book as originally envisioned (meaning the webhook needs pipeline-stage logic added), or was jumping straight to Job Booked an intentional simplification worth keeping? This needs a decision before any of the remaining steps (PO-suggestion auto-trigger, PO-received auto-advance) are worth building, since they're keyed off stage transitions that currently don't happen on this path.

**Key principle carried through, still true:** every step that involves money or committing to a supplier should stay a real, visible action a human can see — automation moves the job forward, it shouldn't hide what happened.

---

## PART J — Quote/Job Page Redesign (mostly built — see A17)

The tabbed layout, activity sidebar, and role-aware display envisioned here are built — see **A17** for current state.

**Still missing:**
- No pie/bar chart rendering — Summary tab uses stat cards and progress bars, not the originally-envisioned Materials/Labour/Profit pie chart or Actual-vs-Invoiced/Actual-vs-Estimated bar charts
- Materials cost split by source (existing stock vs newly purchased), PO status at-a-glance ("3 of 4 POs fully received"), and job-level "needs attention" flags on the Summary tab are not yet built
- No dedicated Notes tab (see E2)

---

## PART K — Site Inspection & Solar Pricing/Design (Pylon data pull built, rest still open)

**Pylon integration (built — see A16):** `pylon-sync.js` is a real, working integration pulling panel/inverter/battery counts and hardware summary from Pylon's `solar_designs` API. This answers the open research question from the original spec — **yes, Pylon does expose this data programmatically** — so "price here, design in Pylon" is achievable via integration, not blocked on unknown API capability.

**Still not built:**
- **In-app solar pricing/design tool:** panels/inverters/batteries with quantities, roof type, gateway, install kits, STC deeming year/month, recommended vs quoted sale price with uplift % — not started. Pylon data is currently pulled for display only, not fed into a pricing calculation.
- **Site inspection checklist on quotes:** a toggle revealing configurable inspection questions/photo requirements — not built, zero related code. Needs its own scoping session (electrical + solar both need coverage, not a straight port of the Runbase reference reviewed earlier).

---

## Explicitly Dropped
- **ServiceM8** — dropped entirely, not just for staged jobs. All SM8 buttons/functions removed. Replaced by native Reactive Jobs workflow (Part F, still to design).
- **Employment Hero** — dropping in favour of direct Xero Payroll AU API push, pending cutover confirmation (H2).
- **TFN/super/bank collection in-app** — dropped entirely; handled through Xero's native employee onboarding instead (see header note). All previously-stored values were cleared.
- **`supplier-bills.html`** — dropped; was an orphaned standalone page that bypassed the trigger-based stock system by writing `quantity_on_hand` directly. Removed rather than fixed.
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
- **Build order matters for dependent features:** e.g. Billable Rates + Materials Database (D1/D2, both done) had to exist before AI Prebuild Generation (D3) or Takeoff/Wholesaler matching (D4) can work.
- **No credential/PII creep:** don't re-add TFN/super/bank/payment-credential collection to the app — that boundary was deliberately drawn at Xero's native onboarding, not a gap to "fix" later.
- **RLS alone isn't enough for role-differentiated writes:** column-level Postgres GRANTs apply to the whole `authenticated` role regardless of which RLS policy let a write through — "admin can change this field, the user themself can't" needs a BEFORE UPDATE trigger, not just a policy (see A14).

---

## Open Decisions
- [ ] **Part I automation chain:** should quote-acceptance job creation step through Quote Approved → Deposit Paid → Ready to Book as originally envisioned, or keep jumping straight to Job Booked? Blocks whether the remaining automation steps are worth building.
- [ ] Reactive Jobs workflow (Part F): formalize Quick Job into it, or build separately? (Bugs & Updates board already has a related request.)
- [ ] Inspection forms (G1): auto-generate client-facing compliance PDF, or internal-only?
- [ ] Confirm Employment Hero → Xero Payroll cutover timing (H2) — don't drop EH until proven stable over a full pay cycle
- [ ] Wholesaler quote matching fallback (D4): manual pairing option, or flag-only, when a line doesn't match a part number exactly? (Not urgent — D4 itself isn't started.)
- [ ] Site inspection checklist (Part K): what questions/photos does this business actually need, given both electrical and solar work
- [ ] Settings "Admin Only" visibility flag (B2): worth building now, or defer until more admin-only settings accumulate?
