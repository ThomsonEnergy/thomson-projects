# Stage Summary — Supplier, PO, Stock & Activity Log System

Covers everything built in this session, beyond what PROJECT_SPEC.md's Part A-I already describes. Upload this alongside PROJECT_SPEC.md when starting a fresh chat that needs to touch any of this. If you need to actually edit any of these files, upload their current versions from your GitHub folder too — this doc describes what exists and why, not the literal code.

**Migrations covered:** 031 through 042 (run in order if not already applied — check via the diagnostic query pattern used earlier in this build if unsure what's been run).

---

## Supplier system (full build)

- **Suppliers directory** (`suppliers.html`) — replaces the old "Supplier Bills" page entirely. Aggregate stats (invoiced-not-paid, approved, not-approved, overdue) across every supplier, click into any one for detail.
- **Supplier detail page** (`supplier-detail.html`) — same four stats scoped to one supplier, flagged line items ("Needs attention" — missing from a PO, or overcharged), bill list, PO list, Activity Log.
- **Hierarchical supplier matching** — when a bill/pricelist/statement is uploaded, matching goes: their account number for us > ABN > their bank details > fuzzy business name, in that order. Built after real MMEM invoices showed the same account (Haymans/Greentech/TLE) under different logos but an identical "Charge To" number — name-only matching would have created duplicates.
- **New supplier auto-creation** — no form. Extracted name + defaults (net 30 terms) creates it immediately, editable later.
- **AI bill extraction** (`extract-supplier-invoice.js`) — pulls supplier name, our account number, ABN, contact details, bank details, BPAY biller code/reference, our order reference (for PO auto-matching), and line items.
- **AI pricelist extraction** — background function (`extract-pricelist-background.js`) since large multi-page pricelists exceed a normal function's ~10s limit and Background Functions cap payloads at 256KB, so the file uploads to storage first and only the path gets passed through.
- **AI statement extraction** — same background pattern (`extract-statement-background.js`), also pulls supplier ABN/contact so a new supplier can be created straight from a statement.
- **Statement reconciliation** — matches each invoice line on the statement against our own bill records, flags mismatches or missing bills.
- **Supplier payments via Airwallex** (`run-supplier-payments.js`) — "Run payments due today," batches multiple due bills per supplier into one transfer, never auto-executes (Airwallex's own maker-checker approval gate is the real safety net).

## Purchase orders — fully rebuilt

- **PO numbering** — sequential from PO2000, prefix/next-number editable in Settings → Numbering, same atomic-counter pattern as quotes/jobs/invoices.
- **Central Purchase Orders page** (`purchase-orders.html`) — brought back from a dead "Coming in Phase 9" stub into a real page. Stats (pending, needs approval, received this month), every PO regardless of destination (job/Stock/vehicle) in one searchable list, one reliable "+ Create PO" button.
- **Three PO destinations**: a job (`project_id`), Stock (`project_id` and `vehicle_id` both null), or a vehicle (`vehicle_id`). A vehicle PO with no supplier means "pulled from Warehouse stock," not a new purchase.
- **Two PO types**: Fixed (locked once created) and Open-ended (any staff member can add items, optional budget cap).
- **Per-line-item receiving** (the current model, replacing an earlier whole-PO "confirm received" button) — each line item gets ticked off individually and sent to a specific destination: Warehouse, a searched job (costs straight to that job via `job_material_usage`, bypassing Stock entirely), or a specific vehicle. Defaults sensibly based on the PO's own destination but always overridable. Shared logic lives in `supabase-client.js` (`openReceiveLineItemPanel`, `renderPoLineItemsReceivable`, `wireReceiveLineItemButtons`) — one implementation, used identically on the supplier page, job page, vehicle page, Stock page, and the central PO page.
- **Searchable material picker** (`buildMaterialSearchRow`, `readMaterialLineRows`) — every PO creation screen now has type-ahead search against Stock, with the option to type a brand-new item not yet in Stock at all.
- **Reconciliation on generic items** — if a PO line was created generic (e.g. "10A power point") and the actual invoice shows something specific, the bill review screen offers to update the PO's line item to match — accept or deny, never automatic.
- **Upload invoice directly into a PO** — skips supplier selection entirely since the PO already knows its supplier; lands straight on the review screen with the scan pre-filled.
- **PO-number auto-matching** — if an uploaded invoice references its own order number, the review screen auto-links to that PO instead of requiring manual selection.

## Stock locations (Warehouse + vehicles)

- **`material_stock_by_location`** table — Warehouse and each stock-holding vehicle are separate rows per material. `materials.quantity_on_hand` is a trigger-maintained total (always the sum of all locations) — existing code that reads `quantity_on_hand` keeps working unchanged.
- **Fleet vehicles** got `vehicle_name`, `asset_number`, and a `holds_stock` toggle. A vehicle with that toggle shows a "Stock" link into `vehicle-stock.html`.
- **Vehicle stock page** — shows current stock in that vehicle, POs for that vehicle, and "Create PO for this vehicle" with the shed-pull vs supplier-purchase choice.
- **Stock page** shows Total stock cost, a Below-minimum count, per-material minimum quantities, a location breakdown per material (Warehouse + each vehicle), a general "Create PO" button, and "Suggest restock PO" for anything below minimum.
- **Known bug class fixed multiple times**: several places (bill receiving, manual stock edits, job-material-usage draws) wrote directly to `quantity_on_hand`, bypassing the location table — the next unrelated location change would silently overwrite that value via the sync trigger. Fixed in the receiving system and the manual edit paths; **a full-build sweep found this same bug still active in 4 more places that were never revisited** (`supplier-detail.html` new-material-from-bill and existing-material-update, `project.html` stock-draw-for-job, `stock.html` manual quantity field) — **these four are confirmed but not yet fixed as of this doc.**

## Activity log

- **Universal table** (`activity_log`) — one shared table for every entity type, not a separate log per feature. `logActivity(entityType, entityId, action, description)` and `renderActivityLog(entityType, entityId, containerId)` are the two shared functions.
- **Fully instrumented**: Purchase Orders (creation from all entry points, per-item receiving, fully-received milestone). Partially instrumented: Jobs (PO creation and material receipt log against the job too), Suppliers (bill approval).
- **Not yet instrumented**: quotes, invoices, stock/material edits, settings changes. The shared functions make this straightforward to add, just not done yet.

## Client-facing proposal page (`quote.html`)

- **Visual fixes applied**: the cover photo's dark overlay was reduced (was 94% opaque, nearly hiding the photo entirely), the company logo now sits in a white badge instead of floating bare against the dark background, and print-specific CSS forces the cover's real colors to print instead of being flattened to black-on-white like the rest of the page (which was leaving white text invisible against white paper).
- **Known real limitation, not fixable via CSS**: the browser's own print header/footer (date, page title, URL) cannot be suppressed by the page — only by the person manually unchecking "Headers and footers" in their print dialog.
- **Still outstanding, not yet built**: quote total and Accept button need to move to the top of the page next to Print/PDF; the page needs to auto-refresh periodically so staff edits show up without a new link; and the full quote-acceptance automation chain (deposit vs full payment choice, auto-invoice creation from the client's own link, auto pipeline progression) is designed and documented in PROJECT_SPEC.md Part I but not yet built at all.

## Quotes/Projects — requested but not yet built

- Delete with select-all/bulk delete, for both quotes and projects. Agreed approach: block/warn if a job already has invoices, POs, or logged time against it, rather than silently cascading through real activity. A shared `checkProjectHasActivity()` and `deleteProject()` were built in `supabase-client.js` (the delete function explicitly cleans up cost centres/line items/photo groups in order, since cascade behavior on that table couldn't be verified locally) — **the actual UI wiring on `quotes.html` and `projects.html` was not completed.**

## Full list of confirmed bugs from the sweep - all now fixed

All four routed through new shared `adjustWarehouseStock()` (increment/decrement) and `setWarehouseStock()` (absolute value) functions instead of writing `quantity_on_hand` directly:

1. `supplier-detail.html` — new material created from a bill (fixed)
2. `supplier-detail.html` — existing material updated from a bill (fixed)
3. `project.html` — drawing existing stock for a job (fixed - also simplified, removing manual running-quantity tracking that's no longer needed since the new helper re-fetches fresh each call)
4. `stock.html` — manual "Add/edit material" quantity field (fixed - now correctly distinguishes "set to this number" from "add this amount")

A follow-up full-codebase sweep (migrations, JS syntax, duplicate functions, broken links, undefined function calls, brace balance, cache-busting versions) found no further issues. A diagnostic script (`migration_audit_diagnostic.sql`) was also built - checks the live database for evidence of all 42 migrations having actually been run, since several earlier in this build turned out not to have been despite existing in the repo.

## PO system Phase 1-2 (built, after this doc was first written)

- **PO numbering** — sequential from PO2000, prefix/next-number editable in Settings, matching the existing quote/job/invoice pattern
- **Central Purchase Orders page rebuilt properly** — was a dead "Coming in Phase 9" stub, now the real thing: stats (pending, needs approval, received this month), every PO regardless of destination in one list, working "+ Create PO"
- **Real bug found and fixed**: the Create PO button on the job page only got wired up if the project already had at least one existing PO - a brand new job's button silently did nothing
- **Searchable material picker** (`buildMaterialSearchRow`/`readMaterialLineRows`) replaced plain dropdowns on every PO creation screen - type-ahead search against Stock, or type a brand-new item not yet catalogued at all
- **Generic-item reconciliation** — if a PO line was created generic (e.g. "10A power point") and the real invoice shows something specific, the bill review screen offers to update the PO to match, accept or deny, never automatic
- **PO-number auto-matching** — invoice extraction now also pulls the supplier's own order/PO reference, auto-linking to the matching PO instead of requiring manual selection
- **Upload invoice directly into a specific PO** — every PO card now has this button, skips supplier selection entirely since the PO already knows it

## Job tasks (built)

- Tasks added at quote stage carry straight through to the job automatically (quote and job are the same underlying record)
- Assignable to a specific person, a role, or left open for anyone free to pick up
- New Tasks page (`tasks.html`), a "Tasks" card on the job page, and a count on Home's "Needs attention" panel
- A "required before scheduling" flag exists per task but nothing currently enforces it automatically - that hook depends on the broader quote-acceptance automation chain (PROJECT_SPEC.md Part I) being built first

## Number-first display convention (built)

- New shared `projectRef()`/`projectNumberOnly()` functions produce one consistent format everywhere: `J{jobNumber} - {name}` once approved, falling back to `Q{quoteNumber} - {name}` before that
- Applied across every job/quote search picker, dropdown, and label found in a full-codebase sweep (11 files) - Purchase Orders, Schedule, Timesheets, Tasks, Suppliers, invoices, cost centre numbers
- One real bug caught mid-sweep: the DNSP project dropdown's query never selected `quote_number` at all, so its fallback would have silently done nothing

## Quote/job page redesign - discussed, scoped, not yet built

SimPro-inspired tabbed layout (Summary / Cost Centres / Purchase Orders / Details) with pie/bar charts on Summary, agreed to include several improvements beyond a straight SimPro copy (materials-by-source split, PO status shown on Summary, reusing the existing labour budget bar pattern, task/bill/PO "needs attention" flags). Fully documented in PROJECT_SPEC.md Part J. Not started.

## Site inspection + Pylon integration - raised, explicitly deferred

Two ideas from reviewing Runbase (a different solar quoting tool) screenshots: a configurable site-inspection checklist on quotes, and a possible pricing-in-app/design-in-Pylon split. Neither scoped or built - documented in PROJECT_SPEC.md Part K as open items needing their own dedicated sessions, including real research into whether Pylon even has an API for this before committing to anything.
