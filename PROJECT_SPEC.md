# Thomson Projects - Build Spec

Reference doc for Thomson Energy's internal project management/quoting app (thomsonprojects.netlify.app). Originally built to supplement ServiceM8 for staged/multi-stage jobs; the plan is to drop ServiceM8 entirely - including reactive/small jobs - once this app can fully cover that workflow. This file lives in the repo root and is kept current there directly - no separate re-upload step needed.

**Stack:** Netlify (Git-connected deploys, serverless functions) - Supabase (Postgres, auth, storage) - Xero (Accounting API + Payroll AU API) - Anthropic API (AI extraction/generation) - Airwallex (payment links, not yet built) - Formbay (STC submission/trading, integration exploration underway, see #27)

**Deployment workflow:** Repo folder is the source of truth. Each build session: edit files in place, commit + push, Netlify auto-deploys. Always run Supabase migrations before or alongside the Netlify deploy.

---

## 1. Time Tracking

- Staff log time in-app against job/stage
- **Built:** app pushes timesheets to Xero Payroll AU API as `DRAFT`, tagged with the job's Xero tracking option, triggered manually from Timesheets by Admin/Finance for a given pay period - safe to re-run, already-pushed hours are skipped rather than duplicated
- Employees, pay templates, payroll calendars remain configured directly in Xero
- Leave requests still go through the in-app leave workflow (built) or Xero UI/Xero Me app
- Bookkeeper reviews and posts pay runs in Xero as normal
- Ordinary Hours earnings rate ID and the job Tracking Category ID are both set once in Settings > Xero Mapping - since neither is visible anywhere in Xero's own screens (they're internal API-only IDs), a "Look up IDs from Xero" button in Settings calls Xero directly and lists them for one-click selection

## 2. Invoicing

Invoicing is app-first: an invoice is created and sent to the client entirely from within the app - the client never sees Xero. Xero receives the same numbers afterward, as a second step, purely for the bookkeeper's records.

**Job numbering (changed from original plan):**
- Quote number is drawn once, atomically, at the moment a quote is created - permanent, never reassigned
- **Job number is NOT assigned at creation.** A database trigger assigns it automatically the moment the project's pipeline stage crosses into "Quote Approved" or beyond (or immediately for Time & Materials / a Direct Job, both of which skip approval entirely). No job number showing is itself the signal that a quote hasn't been approved yet - deliberate, so status is readable from the number alone
- Cost centre numbers are computed on the fly as `{job number}-{stage position}` (e.g. `7014-2`) - not stored, so reordering/adding stages never leaves stale numbers behind

**Invoices are their own table, not columns on a stage:**
- A stage can be claimed more than once - progressive/partial billing - so each invoice is its own row referencing the stage, rather than one invoice per stage
- Sales invoices: sequential, starting at **SI3000**, one global counter. Prefix and starting number both editable in Settings > Numbering
- **Standalone invoices** (no job or quote attached) are also supported - for a one-off charge, callout, or anything outside the job pipeline. Created from the Invoices tab directly: pick or create a client, describe what it's for, set the amount
- Both the invoice's Labour/Materials split and the invoice number itself are editable in a confirmation step before anything is created - not locked to the full quoted total or an auto-assigned number, so a partial claim or a manually-chosen number both work
- The client-facing invoice page shows the **actual itemized quote line items** (matching how they were written in the quote), not a collapsed Labour/Materials summary - plus a claim summary section (stage total, claimed to date, this claim, remaining) and a list of previous claims on that stage, styled after the old SimPro invoice layout (header bar, Bill To, itemized table, claim summary as effectively a "second page")

**STCs (Small-scale Technology Certificates):**
- STC entitlement is set once per stage at quote time (`stc_total`)
- Applied per-invoice as a post-GST credit - shown on the client invoice as "Total inc GST" then "STC Credit: -$X" then "Balance Due", matching real solar-invoice conventions
- If an STC credit isn't applied on a given claim, the claim summary explicitly says so ("will be credited on a future invoice") rather than silently omitting it
- Client's `client_type` (Individual/Company, set on the Clients page) drives which Xero account code and tax type the STC line uses automatically when pushed - individual assignment is GST-free, company assignment attracts GST

**Xero push, as a separate step:**
- Pushing an already-created invoice to Xero copies its exact numbers across as a DRAFT - Labour and Materials as two lines, plus a third STC Credit line when applicable
- Xero account codes (set in Settings > Xero Mapping, admin-only): 2001 Materials Sell, 2002 Labour Sell, 2003 STC Credits GST Free (Individual), 2004 STC Credits GST Inc (Company), 2005 STC Trading Variance (manual/bank-rec use only, not posted to programmatically - see below)
- Reference field carries job context, e.g. "Job 7014 - Sales Invoice 2 of 3 (Rough In)"
- A Xero webhook (subscribed to the Invoices topic) marks the invoice paid in-app automatically once Xero shows it settled - verified via HMAC signature using a Webhook Key (separate from the Client Secret) stored in Settings > API Keys

**STC settlement variance (a bookkeeping habit, not an app feature):** the amount credited to a customer at quote time and what Formbay/the STC buyer actually pays weeks later won't always match exactly. Since the app has no visibility into that payment (only Xero's bank feed does), the fix lives entirely in Xero: when reconciling that payment, split the bank line across the STC asset account (2003/2004, clearing it back toward zero) and account 2005 (the variance, income or expense depending on direction). No screen needed in the app for this - it's a five-second habit change to a reconciliation step the bookkeeper already does.

## 3. Payment Details & Airwallex

**Built:** Settings > Payment Terms (admin-only) has structured bank fields - bank name, account name, BSB, account number - shown properly formatted on the client invoice. Payment reference is always the invoice number itself, no separate field needed.

**Not yet built - Airwallex Payment Links:** chosen over Stripe because Thomson Energy banks with Airwallex, so funds settle directly into the existing account. Plan: generate a Payment Link per invoice via Airwallex's Create Payment Link API, invoice number as reference/title, shown alongside the bank transfer details on the invoice; a `payment_intent.succeeded` webhook auto-marks the invoice paid (same pattern as the Xero webhook already built). **Before building:** needs real Airwallex API docs and sandbox credentials confirmed first - same approach taken with Xero and Formbay, since guessing at endpoint shapes for a payments API isn't something to do blind.

## 4. Cost/Profit Dashboard - not yet built

- Labour actuals: pulled from Xero Payroll (native once timesheets are pushed there - already happening, see #1)
- Job expenses: pulled from Xero Accounting API, filtered by Tracking Category matching job/stage codes
- Compared against app's own quote line items -> quoted vs actual vs profit
- **Decided approach:** no per-job overhead allocation - added complexity for a number that's still just an estimate. Per-job view shows gross profit only (revenue - direct labour - direct materials, quoted vs actual, labour margin vs materials margin split). A separate net P&L (total revenue and overhead pulled from Xero P&L, run monthly at business level) answers "is the business profitable overall," kept deliberately separate from job-level figures
- **Depends on:** Billable Rates (#28) and Materials Database (#29) existing first, so the underlying cost data is actually accurate rather than built on estimates

## 5. Supplier Invoice Upload - not yet built

- Upload PDF or photo of a supplier invoice
- Anthropic API extracts: supplier, invoice number, date, line items, quantities, unit costs, GST, total
- Match against open POs by supplier + PO number
- **Review/confirm screen required** before saving - no blind auto-save, extraction isn't perfect
- Line items carry their own job/stage ID, reassignable after the fact - updates cost attribution and PO received-status on both jobs
- PO status recalculates if a reconciled line item is later moved
- Finalized invoice pushes to Xero as a **Bill**, tracking category per line item
- Manual entry fallback needed for low-quality scans
- **Bundle with Materials Database (#29)** when built - this is explicitly how that database gets populated from real purchases, building one without the other means typing every material in by hand

## 6. Reactive Jobs (replaces ServiceM8) - not yet built as a full workflow

ServiceM8 is being dropped entirely, including for reactive/small jobs.

- **Quick job entry**: address, client, description - no cost centres/stages, no quote/approval step, no proposal generation
- Reuses the same in-app field features as staged projects: notes, photos, checklists, staff assignment
- Time logged the same way as staged-project time, flows to Xero Payroll the same way
- Materials/parts logged as simple line items (no markup/margin structure needed the way staged quotes have)
- Invoiced directly to Xero on completion
- **Open decision:** does a reactive job get its own numbering series, or share the 7000-series? Does it need any sign-off, or go straight to booked?
- **A related, simpler capability is already built:** "New job - no quote" on the Projects tab creates a job directly (name, client, site address), skipping the quote/approval step entirely and landing straight in Job Booked with a job number assigned immediately. This isn't the full Reactive Jobs workflow described above (no notes/photos/checklist scaffolding tailored to small jobs, no lightweight materials-logging flow) but covers the immediate "I need to invoice something that was never quoted" need via the Invoices tab's standalone invoice tool. Worth treating the full Reactive Jobs workflow as building *on top of* this rather than from scratch
- **Cutover plan:** run in parallel with ServiceM8 for a period before dropping it entirely

## 7. In-App Field Features (Web App / PWA)

- Notes: timestamped, diary-style, per job/stage
- Photos & files: Supabase storage
- Checklists: per stage type
- Staff assignment: per stage or per task
- **Offline support is a later, separate phase** - not attempted yet. Start with SWMS/Take 5 as the first offline test case eventually

## 8. Roles & Permissions

| Role | Access |
|---|---|
| Admin | Everything |
| Finance | Xero-level data: invoices, payments, P&L, POs |
| Sales | Job-level pricing/quoting, no Xero/payroll |
| Staff | Jobs, notes, photos, checklists - no pricing/cost data |

- Enforced via Supabase Row Level Security at the database level, not just hidden in UI
- **Settings restructure (built):** Company Details, Xero Mapping, Numbering, and Payment Terms & T&Cs are now admin-only, hidden from Finance/Sales/Staff entirely (previously visible to more roles than intended)
- Activity log (#12, not yet built) will follow the same role restrictions once it exists

## 9. Proposal Templates

- **New Build**: multi-stage, deposit (10% default), full scope of works, per-stage photo groups, T&Cs, photo category = electrical
- **Solar Proposal**: Pylon design link prominent on cover, photo category = solar
- **Quick Estimate**: single cost centre, no deposit, editable "estimate only" disclaimer banner, formal Accept-button flow (same as other templates, just no deposit/payment schedule shown). Invoiced from actuals, not the estimate figure
- **Time & Materials**: single cost centre, no quote/approval step - job goes straight to booked
- **Direct Job (built, new):** not really a "template" in the proposal sense - created via the Projects tab's "New job - no quote" button, skips the quote wizard and cost-centre/stage builder entirely, straight to Job Booked with a job number assigned immediately

## 10. Photo Library

- Tagged by category: electrical / solar / general
- Templates only surface relevant category by default

## 11. Field Forms (with digital signature capture) - not yet built

- **SWMS**, **Take 5**, **Variation Form**, **Solar Inspection**, **Electrical Inspection** - see full detail in earlier spec drafts if needed, unchanged from original plan
- **Open decision:** do inspection forms auto-generate a client-facing compliance certificate PDF, or stay internal-only?

## 12. Job Activity Log - not yet built

- Per-job timestamped feed: created, line item changes, file/photo uploads, invoice generated/sent, PO created/received, variation submitted/signed, staff assigned
- Auto-populated as a side effect of using the app
- Role-restricted same as elsewhere: Staff see the fact of an action but not $ amounts

## 13. UI Theme

- **Navy Pro** (indigo-led, light background) and **Dark Trade** (charcoal, electric blue accent)
- User-level setting, saved to Supabase, persists across devices
- Toggle in Settings > Appearance, switches instantly

## 14. Job Pipeline Board

**Stages (left to right):**
1. Lead - manual entry
2. Draft Quote - manual
3. **Quote Approved** - auto, client accepts on-screen. **This is also the trigger point for job number assignment** (see #2) - moving a card into this stage (or any stage after it) draws a job number automatically if one doesn't already exist
4. Deposit Paid - auto, Xero shows deposit invoice paid
5. Ready to Book - auto, follows deposit paid
6. Job Booked - manual, staff assigns dates/crew
7. Job Not Complete - manual flag (reason: parts/access/weather/other)
8. Client Handover - auto, final checklist/sign-off completed
9. Awaiting Payment - auto, final invoice generated
10. Archived (off board) - auto, Xero shows invoice paid

**Manual-only transitions:** Draft Quote, Job Booked, Job Not Complete, and Not Complete -> Job Booked

## 15. Navigation & Branding

- Logo top right of app header, links to the Home page (#26)
- Top nav: Leads - Sales - Quotes - Projects - Invoices - Purchase Orders - Timesheets
- **Mobile nav (built, fixed a real bug):** a hamburger menu replaces the horizontal-scroll tab strip on narrow screens. A CSS ordering bug meant the hamburger button was hidden regardless of screen width for a period - fixed
- **Landing page (changed):** everyone lands on the new Home page (#26) after login, on both mobile and desktop - previously mobile defaulted to Timesheets and desktop to the Projects board

## 16. Favicon & Home Screen Icon

- "TE" monogram mark, full PWA icon set + manifest.json in place
- Favicon caching issues are almost always a browser-cache problem, not a deployment problem - confirmed working correctly once cache is cleared

## 17. Settings & Configuration

| Category | Access | Contains |
|---|---|---|
| Company Details | Admin only | Name, ABN, address, phone, website, licences, logo, tagline, Google Maps API key |
| Xero Mapping | Admin only | Account codes + tax type per category, Xero connection IDs (tracking category, ordinary earnings rate), "Look up IDs from Xero" tool |
| Numbering | Admin only | Next quote/job/invoice numbers, invoice prefix |
| Payment Terms & T&Cs | Admin only | Terms text, Quick Estimate disclaimer, structured bank details |
| Quoting Defaults | Pricing roles | Default markup %, default deposit % |
| Job Defaults | Everyone | (was "ServiceM8 Defaults" - repurposed since ServiceM8 was dropped) |
| Photo Categories | Everyone | Electrical / Solar / General |
| Prebuild Categories | Pricing roles | Electrical/Solar subcategories |
| Users & Roles | Admin only | See #18 |
| API Keys | Admin only | Anthropic, Pylon, Xero (Client ID/Secret/Webhook Key), Formbay |
| Appearance | Everyone | Theme toggle |

## 18. User Management

- Users live in Supabase Auth; managed via an Admin-only Users screen in Settings
- **Two ways to give someone access (built):**
  - Send an invite email (Supabase sends it, they set their own password) - **note:** Supabase's default email sender is testing-only and rate-limited; reliable delivery needs a real SMTP provider configured in Supabase Dashboard > Authentication > SMTP Settings, which hasn't been done yet as of this writing
  - **Set a password directly** (with a Generate button) and give it to them yourself - built specifically as a workaround for the above
  - Existing users also get a "Set password" action for the same reason
- **Editable name (fixed a bug):** the Users table previously had no working way to edit an existing user's name - fixed, inline editable now
- **Full profile screen (built):** click "Profile" on any user - editable name, mobile number, photo upload, notes, and a repeatable industry licence list (name/number/expiry date)
- **Deliberately not yet built:** KPIs, wage/rate, industry allowances (travel/tool/leading hand) - noted for later
- **Not yet built:** tagging each user with a Billable Rate tier - depends on Billable Rates (#28) existing first

## 19. Prebuilds

- Record structure, components, quoting behaviour: unchanged from original plan
- **Not yet refactored** to reference the Materials Database (#29) as backing table - still stores standalone cost/material lines, correctly waiting on #29 to exist first

## 20. Lead Capture (from the marketing website)

- Unchanged from original plan - shared Supabase project with the marketing site, `leads` table, auto pipeline-card creation, file attachments via private storage

## 21. AI Quote Helper

- One button on the quote builder drafts a scope-of-works description per stage, then writes the full scope-of-works document
- **Extended (built):** the AI now also suggests a fitting **name** for each stage based on the brief, not just the description - replaces generic placeholder names (Site Power/Rough In/etc.) when they don't actually suit the job, while keeping the same number of stages
- Optional supporting documents (plans, electricity bills) can be attached and referenced

## 22. Client Base

- `clients` table, `client_contacts` for per-role contacts, client picker with auto-create-on-save
- **`client_type` field (built):** Individual or Company, drives STC tax coding automatically (see #2)
- **CSV import, substantially rebuilt (built):**
  - Works with any CSV, not just ServiceM8 exports (renamed from "Import from ServiceM8" to just "Import")
  - AI-assisted column mapping - reads actual header names and sample values to guess which column is Name/Email/Phone/Address, rather than fixed keyword matching alone
  - Email and Phone support **multiple fallback columns** (e.g. a file with separate Mobile/Telephone/Billing Mobile/Billing Telephone columns) - tries each in order, uses the first non-empty value, so no one's number gets dropped just because it was recorded in a different column
  - **Optional billing/alternate contact mapping:** a Billing Phone/Email creates an "accounts" client_contacts entry; an Alternate/Mobile phone creates a "job" contact, but only if it's actually different from the main phone (no pointless duplicate)
  - **Duplicate detection is name-based**, not email/phone-based (multiple real clients can legitimately share a phone/email - families, shared office lines). Same-named rows (within the file, or matching an existing client) get a per-field merge tool - pick the best email from one version, the best phone from another - producing exactly one client per group rather than several
  - **Incomplete records** (no email and no phone, even after checking all fallback columns) get flagged with inline fields to fill in directly, or a checkbox to exclude, with select-all/none for fast batch handling
- **Not yet built:** the Client hub cards described in the original Part E of the spec (one place per client showing every linked job/quote/invoice) - currently the Clients page has an edit form and contact list, but no such hub view

## 23. Timesheets, Leave, and Staff Schedule

- Unchanged from original plan - clock in/out, leave requests, Schedule calendar, mobile-friendly entries table, today's-schedule quick clock-in, multi-cost-centre time splitting with linked sliders, manual entry editing
- **Cost centre picker at clock-in (built):** after picking a job, numbered stage chips appear (e.g. "7014-2 Rough In") - tap one for a single stage, tap several if bouncing between them during the session. Single tap ties the entry straight to that stage; multiple taps clock in against the job as a whole and the Split tool picks up exactly those tapped stages (not the job's full stage list) when clocking out
- **Slider bugs fixed:** dragging used to be impossible because every movement re-rendered the whole panel, tearing the slider out from under the cursor - rewritten to update in place. Rebalancing used to redistribute across every other slider including ones already set - rewritten to a waterfall model where adjusting one slider only shifts the ones after it (or before it, if it's the last one), so earlier choices never get disturbed

## 24. Xero Integration

- **Custom Connection** (client_credentials grant), Client ID/Secret from the Xero Developer Portal, stored in Settings > API Keys
- Granular scopes: accounting.contacts, accounting.invoices, accounting.settings.read (payroll scopes added when Payroll work began)
- No tenant-id header needed - Custom Connections are locked to one organisation already
- Tokens requested fresh per server-side call rather than cached/refreshed - simpler, one extra API call per Xero-touching function run
- Webhook (Invoices topic) verified via HMAC-SHA256 using a Webhook Key separate from the Client Secret - a real bug was found and fixed here: failures were returning 401 with no logged reason, making it impossible to tell "wrong key" from "no signature" from "key not saved yet." Now logs which failure mode was hit (without ever logging the actual secret)

## 25. Formbay Integration (STC submission & payment) - exploration underway, not built

- Formbay handles STC application submission/compliance and (separately) STC trading/sale
- Confirmed via their public API reference (api-doc.formbay.com.au): a real REST API exists for job/form submission (Form, Formset, Assignment objects) - this half is buildable
- **Not confirmed:** the OAuth2 token exchange endpoint (missing from their public docs), and whether payment/settlement data is exposed via API at all, or only in their web dashboard. A possible separate Trading API (trading.formbay.com.au) may be where payment data actually lives, if anywhere
- A diagnostic tool exists in Settings (Test Formbay Connection) that tries several plausible auth methods against their API and reports exactly what comes back - built specifically so a support request to Formbay could include concrete evidence rather than a vague "how does your API work"
- **Next step:** waiting on a reply from Formbay support before building anything real here

## 26. Home Page - built, not in original plan

- New landing page (see #15) with three parts:
  - **Quick nav:** one-tap cards to every major section
  - **Needs attention:** pulls from data that already exists - today's schedule, jobs flagged "Job Not Complete," (pricing roles) draft quotes sitting unfinished and invoices overdue past 14 days, (Admin/Finance) pending leave requests
  - **Company feed:** post a message, everyone can like and comment - a plain company noticeboard, not pricing-restricted, every role reads and participates equally

## 27. Auth Persistence & Biometric Login - not yet built

- Persist the Supabase Auth refresh token locally so staff aren't prompted for username/password every time they open the app
- Face ID / biometric unlock via the WebAuthn API (supported by iOS Safari and Android Chrome) - not a native-app-only feature
- 2FA explicitly left out - not required by Xero's machine-to-machine connection, and adds friction that isn't wanted

## 28. Billable Rates - not yet built

- Settings > Billable Rates: hourly rate tiers (Apprentice/Tradesman/Licensed Electrician/Supervisor), each with a cost rate and sell rate
- Each staff profile tagged with their applicable tier
- Jobs automatically roll up logged timesheet hours x rate into a running labour cost per job/stage, in real time
- "Labour" becomes its own selectable line item type in the quote builder and invoice - hours x sell rate

## 29. Materials Database - not yet built, likely its own build phase

- New table: material name, cost price, sell price, category, supplier
- Populated/updated from PO uploads (ties into the existing PO tracker) or supplier price list uploads (AI extraction - bundle with #5)
- Materials selectable as quote/invoice line items alongside labour and prebuilds
- Prebuilds (#19) refactored to reference this table rather than storing standalone lines

## 30. AI-Assisted Prebuild Creation & Takeoff/Wholesaler Loop - not yet built

- Depends on #28 and #29 existing first - the AI needs something concrete to match components against
- From a text description or an uploaded prebuild list, AI generates a part number, client-facing description, and labour/material components - review before save, never auto-saved
- Plan-reading: a named part number gets added to a takeoff list for wholesaler pricing; a generic mention gets a default item. Wholesaler quotes get matched back against the takeoff list to update costs
- **Open decision:** manual pairing fallback or flag-only when a wholesaler line doesn't match a part number exactly?

## 31. Client & Job Card UX Overhaul - not yet built

- **Client hub cards:** one place per client showing every linked job/quote/invoice - currently missing, flagged in #22
- **Tabbed job/quote cards:** Notes / Scope of Works / Cost Centres as tabs instead of one long scrolling page - pure UX polish, no dependencies, lower urgency than the hub cards
- **Materials export by cost centre:** download a job's full materials list split by stage, for sending to suppliers - depends on #29/#30, reuse the same export logic as the takeoff list rather than building a second one

## 32. Supplier Payments via Purchase Orders (Airwallex) - not yet built, vision documented

Extends Supplier Invoice Upload (#5) with a pay-from-PO workflow, rather than paying suppliers off an end-of-month statement.

- **AI cross-check before payment:** when a supplier invoice/statement is uploaded, AI checks every line against the app's own PO and stock records - confirming each item was either costed to a specific job or received into stock, so nothing gets paid for that was never actually received
- **Overcharge detection:** matches part numbers against the app's own invoice history for that supplier, flagging if the same item has crept up in price since last time - a human reviews the flag, never an automatic rejection
- **Pay-from-PO:** once a PO is marked received and approved, Accounts can pay the supplier directly against that specific PO, rather than waiting for a monthly statement reconciliation. Likely lives on the Purchase Orders tab, or a dedicated "Pay Suppliers" tab if POs and payments end up needing visually separate views
- **Airwallex handles the actual payment execution** - the app only ever proposes a payment (which PO, which supplier, which amount), it never has custody of funds or unilateral power to move money
- **Confirmed via Airwallex's own API docs: a genuine "maker-checker" approval workflow already exists on their side**, not something this app needs to build or enforce itself:
  - The app creates a Transfer via Airwallex's API to pay a supplier
  - If Airwallex's Transfer Approval Workflow is enabled on the account, that transfer lands in `IN_APPROVAL` status rather than executing immediately
  - A webhook (`payout.transfer.in_approval`) notifies the app it's pending
  - **The actual approval happens by logging into the Airwallex web app directly** - not this app - going through Airwallex's own login and already-standard 2FA
  - Only once approved there does the transfer proceed to `SCHEDULED` and pay out
  - Airwallex explicitly recommends **separation of duties**: whoever triggers the payment from within the app should not be the same person configured as an approver in Airwallex - so the person marking a PO "ready to pay" and the person who logs into Airwallex to actually approve it can genuinely be two different people, a real two-person control rather than just a 2FA prompt to the same person
- **Action needed before building:** confirm the Transfer Approval Workflow is actually enabled on the Airwallex account (may need switching on under Airwallex web app > Settings > Approvals, or may need to be requested from Airwallex support - one line in their docs suggests "creating a transfer to be submitted for approval is available upon request")
- **Sequencing:** this depends on Materials Database (#29) existing for the overcharge-detection-by-part-number piece to have real historical price data to check against, and naturally extends the same AI extraction engine planned for #5 - not a separate build from scratch

---

## Explicitly Dropped

- Editable Word doc proposal workflow
- **ServiceM8 integration** - replaced by the native Reactive Jobs workflow (#6) and, for the simplest cases, the Direct Job + standalone invoice tools already built
- 2FA - left out, see #27

---

## Current State Summary (as of this revision)

**Fully built and live:** Time tracking + Xero payroll push, invoicing (app-first, STC handling, standalone invoices, webhook payment sync), Xero connection, proposal templates + Direct Job, photo library, roles/permissions + settings admin-gating, job pipeline board with numbering-on-approval, favicon, user management overhaul, client base + AI CSV import, AI quote helper (now with stage naming), timesheets/leave/schedule with cost-centre clock-in, the Home page.

**Not yet built, roughly in the order it makes sense to tackle them:**
1. Airwallex Payment Links (#3) - standalone, no dependencies, needs real API docs first
2. Billable Rates (#28) - foundational for accurate job costing
3. Materials Database (#29) + Supplier Invoice AI Extraction (#5) - bundle together, the latter is how the former gets populated
4. Cost/Profit Dashboard (#4) - only meaningful once #28+#29 exist
5. Client hub cards (#31) - small, standalone, good quick win any time
6. Reactive Jobs workflow (#6) - timing depends on urgency of dropping ServiceM8 for small jobs
7. Tabbed job/quote cards (#31) - polish, no dependencies
8. Auth persistence & biometric login (#27) - quality of life, standalone
9. AI Prebuild Creation + Takeoff/Wholesaler loop (#30) - needs #28+#29 solid first
10. Materials export by cost centre (#31) - needs #29/#30
11. Job Activity Log (#12) - could be pulled earlier if better audit trails are wanted sooner
12. Field Forms, Offline Support, SMS/Calling (#11, #7's offline note, Twilio) - longer-range, correctly last
13. Formbay integration (#25) - blocked on their support reply, not a sequencing choice
14. Supplier Payments via Purchase Orders (#32) - depends on #29 (Materials Database) for the overcharge-detection piece, and extends #5's AI extraction engine

---

## Open Decisions

- [ ] Reactive jobs: own numbering series, or share the 7000-series?
- [ ] Reactive jobs: any sign-off step needed, or straight to booked?
- [ ] Inspection forms: auto-generate client-facing compliance PDF, or internal-only?
- [ ] Confirm Employment Hero -> Xero Payroll cutover timing with bookkeeper (payroll push is built and testable, but don't drop EH until it's been trusted for a full pay cycle)
- [ ] Wholesaler quote matching fallback: manual pairing option, or flag-only, when a line doesn't match a part number exactly?
- [ ] Formbay: waiting on their support reply re: token endpoint and whether payment data is exposed via API at all
