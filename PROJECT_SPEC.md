# Thomson Projects — Build Spec

Reference doc for Thomson Energy's internal project management/quoting app (thomsonprojects.netlify.app). Originally built to supplement ServiceM8 for staged/multi-stage jobs; as of this revision, the plan is to drop ServiceM8 entirely — including reactive/small jobs — once this app can fully cover that workflow. Save this in the repo root and update as decisions change.

**Stack:** Netlify (Git-connected deploys, serverless functions) · Supabase (Postgres, auth, storage) · Xero (Accounting API + Payroll AU API) · Anthropic API (AI extraction/generation)

**Deployment workflow:** Permanent local GitHub Desktop clone as source of truth. Each build session: edit files in place in that folder, GitHub Desktop shows the diff, commit + push, Netlify auto-deploys.

---

## 1. Time Tracking — Replace Employment Hero

- Staff log time in-app against job/stage
- App pushes timesheets to Xero **Payroll AU API** as `DRAFT`, on a schedule (e.g. weekly)
- Employees, pay templates, payroll calendars remain configured directly in Xero
- Leave requests still go through Xero UI or Xero Me app (API can't create leave requiring approval)
- Bookkeeper reviews and posts pay runs in Xero as normal
- Timesheet lines can carry a Tracking Category (job/stage) for cost reporting — requires "Timesheet Categories" enabled under Xero Payroll Settings first

## 2. Invoicing

**Split by job type:**
- Reactive/small jobs → invoiced from the app directly to Xero's **Invoices API**, same as staged projects, once the Reactive Jobs workflow (see #5) is built — this replaces ServiceM8's invoice-on-completion flow
- Staged projects → invoiced from the app directly to Xero's **Invoices API**

**Numbering:**
- Progress claims: sequential, starting at **PC2000** (PC2000, PC2001, PC2002...) — one global counter, not per-job
- Project reference carried in Xero's `Reference` field, e.g. "Job 7014 — Progress Claim 2 of 4"
- Projects themselves numbered separately, starting at **7000-series** (7001, 7002...), incrementing independently — this is the project's permanent ID shown everywhere in-app

**Tax & account coding per line item:**
- `TaxType` toggle per line: GST on Income / GST Free Income / BAS Excluded
- `AccountCode` per line item, mapped from a locked lookup table (line item type → correct Xero account code + valid tax types), so mismatched combinations can't be pushed (Xero rejects TaxType/AccountCode mismatches)
- Example: STC credits code to a separate income account from standard Service Income
- **Action needed:** confirm actual Xero chart-of-accounts codes with bookkeeper before building the mapping table

## 3. Cost/Profit Dashboard

- Labour actuals: pulled from Xero Payroll (native once timesheets are pushed there)
- Job expenses: pulled from Xero Accounting API, filtered by Tracking Category matching job/stage codes
- Compared against app's own quote line items → quoted vs actual vs profit
- Overheads: not job-specific in Xero — allocate via simple rule (e.g. spread by labour hours), not pulled per job
- Job-specific expenses tracked via Purchase Orders (see #4)

## 4. Supplier Invoice Upload

- Upload PDF or photo of a supplier invoice
- Anthropic API extracts: supplier, invoice number, date, line items, quantities, unit costs, GST, total
- Match against open POs by supplier + PO number
- **Review/confirm screen required** before saving — no blind auto-save, extraction isn't perfect
- Line items carry their own job/stage ID (not just invoice header), so one invoice can be split across jobs
- Line items can be **reassigned** to a different job/stage after the fact — updates cost attribution and PO received-status on both jobs
- PO status recalculates if a reconciled line item is later moved
- Finalized invoice pushes to Xero as a **Bill**, tracking category per line item
- Manual entry fallback needed for low-quality scans

## 5. Reactive Jobs (replaces ServiceM8)

ServiceM8 is being dropped entirely, including for reactive/small jobs — this section replaces what used to be "ServiceM8 Integration." Small jobs need a much lighter path than the full multi-stage quote builder.

- **Quick job entry**: address, client, description — no cost centres/stages, no quote/approval step, no proposal generation
- Reuses the same in-app field features as staged projects (see #6): notes, photos, checklists, staff assignment
- Time logged against the job the same way as staged-project time (see #1), flows to Xero Payroll the same way
- Materials/parts logged as simple line items (no markup/margin structure needed the way staged quotes have)
- Invoiced directly to Xero on completion (see #2) — replaces ServiceM8's invoice-on-completion flow
- **Open decision:** does a reactive job get its own numbering series, or share the 7000-series project numbers? Does it need any sign-off step, or go straight to booked/in-progress like the Time & Materials proposal template (#8)?
- **Cutover plan:** run this in parallel with ServiceM8 for a period before actually dropping ServiceM8 — don't cut over on day one. See Explicitly Dropped below for what happens to the SM8 integration code that already exists.

## 6. In-App Field Features (Web App / PWA — not a separate native app)

- Notes: timestamped, diary-style, per job/stage
- Photos & files: Supabase storage
- Checklists: per stage type
- Staff assignment: per stage or per task
- **Offline support is a later, separate phase** — not attempted in this build. Start with SWMS/Take 5 as the first offline test case eventually.

## 7. Roles & Permissions

| Role | Access |
|---|---|
| Admin | Everything |
| Finance | Xero-level data: invoices, payments, P&L, POs |
| Sales | Job-level pricing/quoting, no Xero/payroll |
| Staff | Jobs, notes, photos, checklists — no pricing/cost data |

- Enforced via **Supabase Row Level Security** at the database level, not just hidden in UI — pricing fields must not be present in API responses to Staff logins, not just visually hidden
- Activity log (#12) follows the same role restrictions

## 8. Proposal Templates

- **New Build**: multi-stage, deposit (10% default), full scope of works, per-stage photo groups, T&Cs, photo category = electrical
- **Solar Proposal**: Pylon design link prominent on cover, photo category = solar, likely single-stage default
- **Quick Estimate**: single cost centre, no deposit, no multi-stage. Clearly labelled with an editable disclaimer banner (defaults to "Estimate only — final invoice based on actual hours and materials used", editable per quote). Invoiced from actuals, not the estimate figure. **Decided:** formal sign-off — same Accept-button flow as other templates, just no deposit/payment schedule shown
- **Time & Materials**: single cost centre, no quote/approval step at all — job goes straight to booked, invoiced from actuals when done

## 9. Photo Library

- Tagged by category: electrical / solar / general
- Templates only surface relevant category by default

## 10. Field Forms (with digital signature capture)

- **SWMS** — task/hazard/control/PPE breakdown, plant/equipment used, each worker signs on site, re-signable per day for multi-day jobs
- **Take 5** — 5 prompts (stop/look/assess/control/monitor), optional photo, single sign-off, done fresh per shift
- **Variation Form** — description, reason, cost impact (labour/materials/markup/new total), sign-off **on-screen or sent as client link** (same signature capture, two entry points), locks and feeds into job's running cost total once signed
- **Solar Inspection** — array/inverter/isolator/earthing checks, compliance photo checklist (dedicated upload slots per required photo), pass/fail, inspector signature
- **Electrical Inspection** — switchboard/RCD/circuit checks, compliance photo checklist, pass/fail, inspector signature
- **Open decision:** do inspection forms auto-generate a client-facing compliance certificate PDF, or stay internal-only?
- Submitted forms auto-generate a clean PDF for the job record/compliance file

## 11. Job Activity Log

- Per-job timestamped feed: created, line item changes (old→new value), file/photo uploads, stage pushed to SM8, invoice generated/sent, PO created/received, variation submitted/signed, staff assigned
- Auto-populated as a side effect of using the app — not manually logged
- Role-restricted same as elsewhere: Staff see the fact of an action (file uploaded, PO received) but not $ amounts or pricing changes

## 12. UI Theme

- Two selectable themes, both derived from actual logo colors (cyan-blue `#1C87C9`, indigo `#3B3486`):
  - **Navy Pro** — indigo-led, light background
  - **Dark Trade** — charcoal background, electric blue accent
- User-level setting (`theme` field on profile), saved to Supabase, persists across devices
- Toggle lives in Settings → Appearance, switches instantly, no reload

## 13. Job Pipeline Board

**Stages (left to right):**
1. **Lead** — manual entry
2. **Draft Quote** — manual, sales building proposal
3. **Quote Approved** — auto, client accepts on-screen
4. **Deposit Paid** — auto, Xero shows deposit invoice paid
5. **Ready to Book** — auto, follows deposit paid
6. **Job Booked** — manual, staff assigns dates/crew
7. **Job Not Complete** — manual flag (reason: parts/access/weather/other), logged to activity log
8. **Client Handover** — auto, final checklist/sign-off completed
9. **Awaiting Payment** — auto, final invoice generated
10. **Archived** (off board) — auto, Xero shows invoice paid

**Manual-only transitions:** Draft Quote, Job Booked, Job Not Complete, and Not Complete → Job Booked (explicit manual rebook once redated — never automatic)

## 14. Navigation & Branding

- Logo displayed top right of app header
- Top nav menu: **Leads · Sales · Quotes · Projects · Invoices · Purchase Orders · Timesheets**
- Each tab shows a running total inline (e.g. "$98.4k out" on Invoices)
- Each tab opens a summary view: stat cards at top, list of individual records below — totals and job-specific detail together
- "Projects" tab is the job pipeline board (#13)

## 15. Favicon & Home Screen Icon

- Browser tab icon + "add to home screen" icon use the **"TE" monogram** mark (not the full wordmark logo — unreadable at small sizes)
- Files generated: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `manifest.json`
- All go in the `public` folder (repo root of served files)
- `index.html` `<head>` needs:
  ```html
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#1C87C9">
  ```
- On phone: open site in browser → Share/menu → "Add to Home Screen"

## 16. Settings & Configuration

Anything that could change without a code change belongs here as an editable database record, not hardcoded — avoids a redeploy every time a detail changes.

| Category | Contains |
|---|---|
| **Company Details** | Name, ABN, address, phone, website, licences, logo, tagline, Google Maps API key (address autocomplete on the site address field) |
| **Xero Mapping** | Account codes + tax type per line item type (Labour Income, Materials/Trading Income, STC Credits, etc.) |
| **Numbering** | Next PC invoice number, next project number — visible/adjustable, not just trusted blindly |
| **Quoting Defaults** | Default markup %, default deposit % |
| **ServiceM8 Defaults** | Job category, default checklist items per stage type |
| **Payment Terms & T&Cs** | Editable text blocks used on proposals/invoices, plus the default Quick Estimate disclaimer wording |
| **Photo Categories** | Electrical / Solar / General — extendable |
| **Prebuild Categories** | Electrical (Lighting/Power/Trenching/Cable Runs), Solar (Panels/Batteries/Inverters) — extendable |
| **Users & Roles** | Staff accounts, role assignment (see below) |
| **Appearance** | Theme toggle (Navy Pro / Dark Trade) |

**User management — in the app, not Netlify**
- Netlify only hosts the site and stores API keys/secrets — it has no concept of staff or roles
- Actual users live in **Supabase Auth**; management happens via an Admin-only "Users" screen in Settings
- Admin adds name + email + role (Admin/Finance/Sales/Staff) → Supabase sends an invite email for the person to set their own password
- Admin can change role or deactivate a user from the same screen — no code or Supabase dashboard access needed day to day

## 17. Prebuilds

A library of frequently-used supply-and-install packages, so common jobs don't get re-quoted from scratch every time.

- **Record structure**: name (e.g. "Supply & Install Downlight"), internal part number, client-facing description, category/subcategory, and a bundle of components
- **Components**: each is either a labour line (hours × role/rate) or a material line (item × cost) — e.g. downlight = 1hr labour + 1 downlight + 1 plugbase
- **On a quote**: staff picks the prebuild and sets a quantity — every component scales automatically (12 downlights = 12× every line in the bundle)
- **Client sees**: description + total price only, no breakdown
- **Internal view**: full labour/materials breakdown, so margin is checkable at a glance
- **Editable per use**: a specific job can tweak an instance without changing the master template
- **Part number is internal-only** — not locked to a specific supplier SKU, so whoever's ordering can read the plain-English description and buy the cheapest suitable option on the day
- **Xero coding**: labour component posts to the **Labour Income** account, materials component posts to a separate **Materials/Trading Income** account — automatic via the same TaxType/AccountCode mapping as #2, split further by labour vs materials rather than one blended code. This also lets the profit dashboard (#3) show labour margin vs materials margin separately, not just one number per job
- **Categories**:
  - Electrical: Lighting, Power, Trenching, Cable Runs
  - Solar: Panels, Batteries, Inverters
  - Searchable/filterable by category when building a quote, not one long flat list

## 18. Lead Capture (from the marketing website)

- The marketing site (thomsonenergy.com.au, separate codebase) shares this same Supabase project — no sync job needed, both apps just read/write the same database
- Public `leads` table, insert-only for anonymous visitors via RLS: `source` ('package' / 'brand' / 'calculator' / 'enquiry_modal'), contact fields, address fields (line/suburb/state/postcode/formatted/lat/lng from Google Places Autocomplete on the site), `status`, and a `details` jsonb catch-all for source-specific context
- **Only enquiry-form submissions (with an email or phone) automatically create a pipeline card** — package/brand/calculator clicks with no contact info are anonymous interest signals, logged for visibility on the Leads tab but not cluttering the pipeline board with nothing to act on
- A database trigger (`on_lead_created`) does the pipeline-card creation automatically: new `projects` row, `pipeline_stage = 'lead'`, `lead_id` set so the two stay linked, a starting `sow_text` note summarising what the person submitted
- Leads tab shows contactable enquiries (linked straight to their pipeline card) separately from anonymous site-interest data
- Marketing site reuses the same Google Maps API key as the quote builder (Settings > Company Details) — just add the marketing site's domain to that key's HTTP referrer restrictions in Google Cloud Console, no second key needed
- **File attachments** (switchboard photos, electricity bills): uploaded from the enquiry modal straight to a private `lead-uploads` Storage bucket (anon can upload, never read/list), paths recorded in `details.attachments` on the lead row. Staff can view them from the Leads tab, and if that lead becomes a quote, one click imports the same files straight into the AI scope-of-works helper (#19) — no re-uploading

## 19. AI Quote Helper

- One button on the quote builder: drafts each stage's description first, then writes a full scope-of-works document using those plus the contractor's rough notes
- Optional supporting documents (plans/drawings as PDF, electricity bills as PDF or photo) can be attached — the model references them when relevant (e.g. existing switchboard capacity, circuit count)
- Documents upload to the same private storage bucket used elsewhere, fetched server-side when generating — never sent through the browser twice
- Everything it drafts is fully editable before saving, same as if typed by hand

---

## Explicitly Dropped

- Editable Word doc proposal workflow — decided against; proposals stay as the in-app/web format
- **ServiceM8 integration** — decided against; replaced by the native Reactive Jobs workflow (#5). Some per-project SM8 push/sync integration was already built in an earlier session (the "Create ServiceM8 jobs" / "Sync costs from ServiceM8" card on the project page, plus `create-jobs` and `sync-costs` Netlify functions and a shared `_servicem8` helper) — this is being removed rather than built further. The `servicem8_job_uuid` / `servicem8_job_status` columns on `cost_centres` can stay in the database unused, or be dropped in a small follow-up migration if you want to tidy up.

---

## Build Order & Test Checkpoints

Each numbered phase = one build session (new chat), one deploy, one round of testing before moving to the next. Don't stack multiple phases into one deploy — smaller changes are far easier to isolate if something breaks.

### Phase 1 — Favicon & home screen icon
*No dependencies. Quick win, good first deploy to confirm the upload/push workflow works end to end.*
- Add icon files + manifest.json to `public` folder, update `index.html` head
- **Test:** hard-refresh browser, check tab icon changed. On phone, add to home screen, confirm icon + app name look right. Check on both iOS and Android if possible.

### Phase 2 — UI shell: navigation, logo, theme toggle, job pipeline board, settings shell
*UI only, no data integrations — safe to build before anything else exists underneath it.*
- Logo top right, nav menu (Leads/Sales/Quotes/Projects/Invoices/POs/Timesheets) with placeholder totals
- Job pipeline board with the 10 stages (static/manual-move only for now, no automation yet)
- Navy Pro / Dark Trade theme toggle in Settings
- Settings page shell with category tabs (Company Details, Numbering, Quoting Defaults, etc.) — each tab gets built out properly in the phase that needs it, this just creates the structure so later phases have somewhere to plug in
- **Test:** click through every nav tab, confirm no dead links/crashes. Switch themes, check every screen (not just the dashboard) renders correctly in both. Log out and back in, confirm theme preference persisted. Test on phone screen width, not just desktop.

### Phase 3 — Roles & permissions (Supabase RLS) + user management
*Foundational — build before adding more sensitive data so nothing needs retrofitting.*
- Role field on staff table, RLS policies for Admin/Finance/Sales/Staff
- Admin-only Users screen: add/invite staff, assign/change role, deactivate
- **Test:** log in as each role (create 4 test accounts). Confirm Staff genuinely cannot see pricing anywhere — check the actual network/API response, not just the UI. Confirm Admin still sees everything. Try to break it: as Staff, attempt to directly hit an endpoint that should be pricing-restricted. Invite a real test user by email, confirm the invite flow works and they land in the correct role.

### Phase 4 — Reactive Jobs workflow (replaces ServiceM8 for small jobs)
*Builds on the pipeline board from Phase 2 and the field features described in #6. Not urgent to build immediately — ServiceM8 keeps handling reactive jobs until this exists and has been trusted for a while.*
- Quick job entry (address, client, description, no cost centres/stages)
- Notes, photos, checklists, staff assignment reused from the same field features as staged projects
- Time logged the same way as staged projects, flows to Xero Payroll
- Simple material line items, no markup structure
- Direct-to-Xero invoicing on completion
- **Test:** run a handful of real reactive jobs through this instead of ServiceM8 for a trial period. Confirm nothing falls through the cracks — job details, time, materials, and the final invoice all end up correct before trusting it for everything. Only fully retire ServiceM8 once this has been running clean for a while.

### Phase 5 — Proposal templates, photo library tagging, and prebuilds ✅ built
*New Build, Solar, Quick Estimate, Time & Materials templates, plus the prebuild library since it plugs straight into quoting.*
- Four templates, photo library tagged by category (electrical/solar/general)
- Prebuild records (name, part number, description, labour/material component bundle), categorized (Electrical: Lighting/Power/Trenching/Cable Runs, Solar: Panels/Batteries/Inverters)
- **Test:** build one real (or realistic dummy) proposal in each template. Confirm Quick Estimate shows the editable "estimate only" banner and still requires a formal accept. Confirm Time & Materials skips the approval step entirely and lands straight in Job Booked on the pipeline board. Add a prebuild to a quote, change the quantity, confirm every component scales correctly and the client-facing view shows only description + price (not the breakdown). Send a test proposal link to your own phone/email and check it renders properly for the client side.

### Phase 6 — Xero invoicing
*Numbering, GST toggle, account code mapping.*
- PC2000 sequential numbering, 7000-series project numbers, TaxType/AccountCode lookup table
- **Test:** push a real test invoice to a Xero demo/sandbox company first, not your live Xero, if at all possible. Confirm invoice number sequence, confirm GST and account code land correctly on each line, confirm a deliberately wrong combination gets rejected rather than silently miscoded. Only point at live Xero once sandbox testing looks clean.

### Phase 7 — Xero payroll/timesheets (Employment Hero cutover)
*Don't drop Employment Hero until this is fully tested — run both in parallel for at least one pay cycle.*
- Timesheet push to Payroll AU API as DRAFT, tied to payroll calendars
- **Test:** run a full pay cycle in parallel — log the same hours in both the app and Employment Hero, compare the numbers before trusting the app's output alone. Have your bookkeeper check a draft pay run built from app data before actually posting it.

### Phase 8 — Cost/profit dashboard
*Depends on Xero invoicing + payroll data actually flowing (Phases 6 & 7).*
- Labour actuals, job expenses by tracking category, quoted vs actual, overhead allocation
- **Test:** pick 2-3 real completed jobs, manually calculate their actual profit by hand, compare against what the dashboard shows. Any mismatch, chase it down before trusting the dashboard for decisions.

### Phase 9 — Supplier invoice upload + PO matching
- AI extraction, review/confirm screen, line-item job reassignment, push to Xero as Bill
- **Test:** upload a batch of real past supplier invoices (messy ones too, not just clean PDFs) and check extraction accuracy. Deliberately test reassigning a line item after saving — confirm both jobs' costs update correctly.

### Phase 10 — Field forms + activity log
*SWMS, Take 5, Variation, Solar/Electrical Inspection, plus the per-job activity feed.*
- Build forms one at a time, ideally starting with Take 5 (simplest) before SWMS/inspections
- **Test:** have an actual staff member fill each form out on their own phone, not just you on desktop — this is the real test of whether the mobile UI works in the field. Confirm signature capture works on both iOS and Android. Confirm activity log entries appear correctly and Staff role can't see $ amounts in the log.

---

## Open Decisions Before Building

- [ ] Reactive jobs: own numbering series, or share the 7000-series project numbers?
- [x] Reactive jobs: any sign-off step needed, or straight to booked like Time & Materials? — **Decided:** matches Time & Materials, no sign-off, straight to booked
- [x] Quick Estimate: formal click-to-accept, or informational only? — **Decided:** formal accept, same flow as other templates minus deposit/payment schedule
- [ ] Inspection forms: auto-generate client-facing compliance PDF, or internal-only?
- [ ] Confirm Xero chart-of-accounts codes for each income category (Service Income, STC Credits, Materials, etc.) with bookkeeper
- [ ] Confirm Employment Hero → Xero Payroll cutover timing (don't drop EH until Xero payroll push is tested and working)
