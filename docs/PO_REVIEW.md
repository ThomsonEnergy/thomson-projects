# Purchase order, supplier bill and stock review (20 Oct 2026)

Read-only review of the PO, supplier bill, payment and stock code against the owner's intended workflow (below). Nothing was changed. Fix plan at the bottom, waiting on the owner's yes. Status tracked in `docs/DECISIONS.md`.

## The workflow we are building to

1. A PO is raised on a job (or for Stock, a vehicle, or Tools) and emailed to the supplier.
2. The supplier's invoice lands against the PO: our PO number on it links it automatically, otherwise it is linked by hand. Invoices do not have to match the PO.
3. On an **open** PO the invoice fills in the lines. On a **fixed** PO the invoice lines are matched to the PO lines. Invoice lines that do not match show in **red**: either add them to the PO by hand or query the supplier (not approved).
4. When the gear arrives, each line is ticked **received** or **back ordered**. Lines no longer needed can be moved to Warehouse stock or a vehicle.
5. Gear received to a job never counts in Warehouse or vehicle stock. Only gear received on the PO is costed to the job; anything moved back to stock comes off the job and goes into stock at cost.
6. Once every line is received (or back ordered / moved off) the PO is **closed**: that is the approval for payment of its matched bills.
7. **Payment date** = the supplier's terms, but never before we have received and approved. Approved amounts show on the supplier's page and go to Airwallex as a batch with the payment date.
8. Stock and vehicle POs work the same, received into the Warehouse or the vehicle by staff.
9. A bill that arrives twice is caught and the duplicate never saved. A statement line with no PO is flagged so we chase which job it belongs to (or an overcharge).
10. Staff pulling stock from a vehicle or the Warehouse for a job make a stock PO from My Day in a few taps. Clock-out asks "Did you take any stock?". Wrong counts are fixed on the spot; a part not in Stock can be added there. The Stock page shows every count correction and who made it.
11. **Tools and equipment register**: tools bought on any PO (job, stock, vehicle or a tools PO) show on a Tools page with purchase date, cost, supplier, bill and who bought it. Tools over $500 need a serial number, a photo of the tool and the receipt.

## What already works

- Raise a PO on a job, Stock or a vehicle; number drawn by the database; email as a PDF (`po.html`).
- Receive per line to the job, Warehouse or a vehicle; back ordered with ETA; Undo received; Move all or part of a line to another job / Warehouse / vehicle. All server side (`po_receive_line`, `po_undo_receive`, `po_move_line`, `po_set_backorder`); no negative stock; job cost comes off on move or undo.
- Receiving to a job writes `job_material_usage` only, never stock (`_po_line_land`). Stock page shows Warehouse and each stock vehicle per item.
- Emailed bills: PO number on the bill or in the email links the PO; total, line and only-open-PO fallbacks; hand pick on the Emailed bills page. Duplicate emailed bills are put aside, never saved.
- Bill checks line by line (not on PO, price up, over ordered, PO total over), Query supplier email, Accept as is.
- Statements: `no_po` ("Invoice X has no PO in TEops") is one of the issue kinds, plus missing bills, amounts that differ, duplicates both ways, balance.
- Close PO approves its matched bills; Reopen is Admin/Finance with a note.
- Payment run (`run-supplier-payments.js`) only lists bills that are approved and past their due date: an unapproved bill is never paid.

## Bugs (worst first)

| # | Problem | Where |
|---|---|---|
| P1 | **Job PO gear double counted into Warehouse stock.** Saving a bill on the supplier page adds every bill line's quantity to Warehouse stock, even when the linked PO is a job PO whose lines were received to the job. Stock rises for gear that is on a job. Bill save should never touch stock (receiving does). | `supplier-detail.html` 787-808, `adjustWarehouseStock` |
| P2 | **Invoiceable actuals ignore where a line went.** A line received to the Warehouse, or moved to another job, is still billed to this job; a line moved in from another job's PO is missed. The job page itself counts correctly. | `get-invoiceable-actuals.js` 90 |
| P3 | **Close PO has no gate.** Any logged-in user can close a PO with unreceived or back ordered lines, and lines can still be received after close. Undo received on a closed PO leaves it closed and approved. | `po_set_closed`, `po_receive_line`, `po_move_line` |
| P4 | **Bills approve before Close.** Bills are approved as soon as every line is received (`_po_sync_received`, `bill-check.js`), so Close is not the approval step. And `purchase_orders.received` goes stale: + Add item, Edit lines or deleting a line on a fully received PO leaves it true, so a new bill on that PO is approved at once. | `20261025000000_po_upgrades.sql` 168-184 |
| P5 | **Bills can never be marked paid.** No code sets `supplier_bills.paid`; nothing writes `supplier_payments`. "Invoiced, not paid" grows forever and the payment run's "mark each bill paid from the supplier's page" points to a button that does not exist. Airwallex payout: not built (returns 501). | `run-supplier-payments.js`, `supplier-detail.html` |
| P6 | **Payment date never moves.** `due_date` is set once from the terms. Approval after that date does not push it, so Overdue on the supplier page counts a bill we are rightly holding. No "pay on" date exists to send with a payment. | `calculate_bill_due_date`, `get_supplier_financial_summary` |
| P7 | **Approve for payment is a browser write.** Supplier page Approve updates the row directly (no `approved_by`, no "New, check details" block server side), allowed to Sales by RLS. | `supplier-detail.html` 168 |
| P8 | **Duplicate bill gaps.** Manual upload has no duplicate check before insert (only flagged after); the emailed check compares the raw bill number ("INV-0103" vs "103" slip through) while `bill-check.js` normalises. | `supplier-bill-intake.js` 331, `supplier-detail.html` 772 |
| P9 | **Browser-side stock writes.** `adjustWarehouseStock` / `setWarehouseStock` read then write with no lock, no log and clamp to 0: Stock page edit, variation "from Stock" (no job cost row, so stock drops with no cost), Suggest PO "from stock" (two calls, not atomic), bill review. Any role can write any count. | `supabase-client.js` 6170-6207, `project.html` 6370, 7449 |
| P10 | **Stock page Edit for Staff half works**: the materials update is 0 rows under RLS (no error), the count still changes, log says "updated". Vehicle counts cannot be edited anywhere except through a stock pull. | `stock.html` 243-247 |
| P11 | **`purchase_orders.status` is dead.** Always 'ordered' (stock pull 'received'); badges show it; three filters exclude `paid, invoiced` which never exist, so closed POs still offer themselves for bill matching. | `supplier-bills.html` 233, `supplier-detail.html` 549, `supplier-bill-intake.js` 314 |
| P12 | **Dates.** `order_date` default is UTC `current_date` (POs before 10am get yesterday); payment run and statement intake use UTC today; "received this month" uses the browser month. | baseline 1255, `run-supplier-payments.js` 41, `statement-intake.js` 131 |
| P13 | Statement `no_po` issue is not styled red on Bill checks and is left out of the statement query email. | `supplier-checks.html` 67, `supplier-email.js` 56 |
| P14 | Manual bill review does many browser inserts in a row (bill, materials, stock, PO line, bill lines) with no transaction: a failure part way leaves a half saved bill. | `supplier-detail.html` 789-845 |
| P15 | RLS: `purchase_orders` full access to every role (any staff can delete a PO or change its amount or cap); `material_stock_by_location` manage-all to authenticated; supplier bill tables use the slow `is_pricing_role()` form `to public`. `calculate_bill_due_date` has no search_path or revoke. | baseline 4424, 4483-4497, `security_fixes.sql` 27 |
| P16 | Deleting a job deletes PO lines from the browser; `job_material_usage.po_line_item_id` has no cascade, so it fails on any received job line. | `supabase-client.js` 6147 |
| P17 | `vehicle-stock.html` "pull from Warehouse" makes an old-style PO that moves stock only when each line is received (two steps, vehicle count lags). | `vehicle-stock.html` 167 |
| P18 | Unescaped `err.message` into HTML at two spots; `${po.status}` unescaped (constrained values, low risk). | `supabase-client.js` 4907, 5791 |

## Missing against the workflow

| # | Gap |
|---|---|
| G1 | **Bill lines on the PO, in red.** Nothing on the PO or job page shows the bills and their lines. Unmatched lines only appear as "Needs attention" on the supplier page. No "Add to PO" action for an unmatched line. Query supplier exists on Bill checks. |
| G2 | **Open PO filled from the invoice.** Bill save never creates PO lines on an existing PO. "Open" today just means a budget cap was typed. |
| G3 | **Pay on date and payment batch.** No "pay on" date (later of terms date and approval date), no mark paid, no batch to Airwallex. |
| G4 | **Stock PO from My Day and the clock-out prompt.** My Day has no stock code at all. A stock pull today is 7 to 9 taps through the job page's Create PO panel. Clock-out never asks about stock. |
| G5 | **Add a missing part on the spot.** Stock pull lines must already be in Stock; staff cannot create materials. The "left after" count is only forced when taking more than the app has. |
| G6 | **Adjustment history on Stock.** Count corrections are logged on the material in `activity_log` with the person, but only `logs.html` (Admin) shows them. Stock page edits log no old / new number. |
| G7 | **Tools and equipment register.** Nothing exists (`assets.html` is customer assets, `fleet.html` is vehicles). |

## Fix plan (owner said yes 20 Oct 2026; Delivery 1 LIVE, migration 20261108000000)

Four consolidated deliveries, each to `main` with its migration on production.

**Delivery 1: PO, bill and stock rules (migration).** P1 to P16, P18.
- Bill save never touches stock or creates materials from the browser; it links or flags lines only. One server function saves a reviewed bill all or nothing.
- Invoiceable actuals count by destination (same rule as the job page).
- `purchase_orders.received` recomputed by trigger on any line change; `status` kept in sync (ordered / part received / received / closed) and the three filters fixed.
- Close: needs every line received, back ordered or moved off (back ordered lines are listed and the closer picks: wait, or close now and the back order is cancelled off the PO). After Close nothing is received or moved without Reopen. Undo received on a closed PO reopens it and un-approves its bills. **Bills approve on Close, not on fully received**; when the last line is received the PO shows "All received, close and approve?" with one tap.
- Approve for payment: one server function, Admin and Finance only, sets who and when, refuses a "New, check details" supplier.
- Pay on date: `supplier_bills.pay_on` = later of the terms due date and the approval date (recalculated on approve and reopen). Overdue tiles and the payment run use `pay_on`. Terms `due_date` stays visible as "Supplier's due date".
- Mark paid: "Paid" button on the supplier page and Bill checks (Admin/Finance, date and reference), writes `supplier_payments`. Payment run becomes "Pay batch": picks approved bills due by a date, records the batch and marks them paid; Airwallex sending stays a stub until the payout key is set up (see question 4).
- Duplicate check on manual upload, normalised bill numbers on both paths.
- One `stock_set_count` function (reason, old, new, who, logged) replaces every browser stock write; Stock page Warehouse and vehicle counts editable through it with a reason; variation "from Stock" also writes the job cost row.
- Sydney dates everywhere listed in P12; RLS tightened per P15; cascade fixed per P16; escaping per P18.

**Delivery 2: bills on the PO.** G1, G2, P13.
- Every PO (job page and Purchase Orders page) gets a **Bills** section: each bill with its lines, green = matched to a PO line, red = not on the PO or price up. Red line actions: **Add to PO** (pricing roles, creates and links the PO line) and **Query supplier** (the existing email). Bill status chip: matches / problems / queried / approved / paid.
- Create PO panels get a clear choice: **Lines known** (fixed) or **Open, fill from the invoice**. On an open PO the bill's lines are added to the PO on save (linked, then received the normal way). A fixed PO matches only.
- Statement `no_po` lines styled red and included in the statement query email.

**Delivery 3: stock from My Day (migration).** G4, G5, G6, P17.
- My Day: **Used stock** button on the current job card, and a clock-out step "Did you take any stock for this job?" (Yes / No, once per job per day). Flow: where from (Warehouse or a vehicle; defaults to the vehicle assigned to the person, `fleet_vehicles.assigned_staff_id`, then last used) > pick items (search, recent items for that person first, big + / - quantity) > for every line "Left in the van?" prefilled with the app count minus what was taken, editable > Done. One tap per item plus Done. Uses `po_create_stock_pull`.
- **Not in Stock? Add it**: staff can add a material from that flow with name and count; it lands flagged **Needs a price** on the Stock page for Admin / Finance (cost 0 until priced, job cost updated when the price is set).
- Stock page: an **Adjustments** list (last 90 days, who, when, app had / actually, which PO) and a "Count corrected" chip on each item with a recent correction. `vehicle-stock.html` "pull from Warehouse" switches to the instant stock pull.

**Delivery 4: tools and equipment register (migration).** G7.
- New table `tools` and page `tools.html`: name, category, serial number, purchase date, cost ex GST, supplier, bill and PO line, bought by and when, assigned to (person or vehicle), location, status (in use / lost / damaged / sold / written off), warranty expiry, test and tag due, photo, receipt, notes. Nav link next to Stock.
- **Tools PO**: a fourth PO kind on the Create PO panels and the Purchase Orders page. Any PO line (job, stock or vehicle PO, from the same supplier as the gear) can be marked **This is a tool** or moved to Tools with the Move action; receiving it creates the tool record instead of a job cost or stock row. Tools under $500 ex GST list as they are; **over $500 the tool shows "Needs serial, photo, receipt"** until all three are on it (photo through `compressImage()`, receipt is the bill file when linked).
- Later (backlog item 1): Tally flags tool-like bill lines, test and tag reminders, Xero fixed asset push.

## Open questions for the owner

1. Close with back ordered lines: wait for them, or allow close now and cancel the back order off the PO (plan assumes the closer picks per PO)?
2. Approve for payment: Admin and Finance only (plan), or Sales too (today)?
3. Pay on date: plan uses the later of the terms date and the approval date. Agree?
4. Airwallex payouts need a payout-enabled API key and a beneficiary per supplier created in Airwallex, plus the accountant's sign-off (backlog item 1). Build the batch and mark paid now, Airwallex send as its own delivery once the key is set up?
5. Staff adding a material from My Day with "Needs a price" for Admin: yes?
6. Tools threshold $500 ex GST, and tools under $500 still listed without the serial and photo rule: yes?
7. **Freight and delivery charges** (added 20 Oct 2026, cloud session): a supplier invoice usually has a freight line that is never on the PO, so under the red-line rule every invoice would show one red line. Plan assumes: freight and delivery lines are matched to a "Freight" line type, accepted automatically up to a cap per PO (say $50, set in Settings), red above it. Agree, and what cap?
8. **Consumables** (cable ties, screws, tape): track them per job in the stock pull, or flag them "consumable, not tracked" so staff are never asked about them at clock-out? Plan assumes a per-item "Consumable" flag on the Stock page, left out of the clock-out prompt.
9. **Returns and supplier credits**: gear sent back to the supplier (wrong part, damaged) and their credit note. Not in the workflow above. Plan assumes a "Returned to supplier" action on a received line (comes off the job cost or stock, waits for the credit note, which Tally matches like a bill with a negative total). Build it in Delivery 1, or later?
10. **Stocktake**: while stock is phased in, a per-location count mode (open the van, walk through every item, type the actual count, one Save, every difference logged as a correction). Build it with Delivery 3, or later?

## Owner's answers (20 Oct 2026, cloud chat)

Everything not listed here is as the plan recommends.

1. Close with back ordered lines: the closer picks per PO (close now cancels the back order off the PO, or wait).
2. Approve for payment: **Sales too** (Admin, Finance and Sales), through the server function with who and when recorded.
3. Pay-on date: later of the supplier's terms date and our approval date. Yes.
4. Airwallex: build the pay batch and the Paid button now; Airwallex send is its own delivery once the payout key and beneficiaries exist.
5. Staff adding a missing part from My Day: yes. It is flagged **Needs a price** in two places: on the job (the stock PO line and the job's cost shows "price missing" until set) and in the Stock list.
6. Tools: $500 ex GST, under $500 listed without the serial and photo rule. Also add **perishables** (drill bits, hole saws, blades) as a tools category. Every tool and perishable sits **in a vehicle or the Warehouse** (location is required) and is adjusted as they break: status broken / replaced / lost, with who and when, so the Tools page always shows what is where and what needs replacing. **Perishables sit in the Warehouse or a vehicle, never on a person.** When a perishable line is received, or moved from the Warehouse to a van (one tap: item, vehicle, how many), the vehicle, date and cost are recorded. Each van has one driver, so the Tools page gets a **By vehicle** view: each vehicle's perishables for the last 12 months (count and cost by item, with the driver's name shown from `fleet_vehicles.assigned_staff_id`) against the fleet average, heavy use highlighted. 50 drill bits into one van is visible at a glance.
7. Freight: **no cap, always red**, so we always see we were charged. Every red line (freight or any other line item) gets **Accept** or **Deny charge**; Deny sends a please-explain email to the supplier (the existing Query supplier email, one line per denied charge, bill stays unapproved until resolved).
8. Consumables (zip ties, saddles, screws, tape): yes, flag them. How they are tracked is below.
9. Returns and supplier credits: later, after the four deliveries.
10. Stocktake mode: with Delivery 3.

### Consumables: how to track them without counting zip ties

Nobody counts 367 zip ties. Consumables are tracked by the **pack**, not the piece:

- A consumable's stock unit is its pack (bag of 100 ties, box of 100 saddles, roll of tape). Cost per pack, minimum in packs. The Stock page shows "3 bags" not "367".
- The stock pull takes whole packs ("grabbed a bag of ties" = 1). Open packs are ignored. Consumables are left out of the clock-out "Did you take any stock?" list.
- **Running low**: one tap on the van or Warehouse stock page, and a short "Anything running low?" list of consumables on the clock-out prompt (tap the item, done). It raises a restock suggestion for Admin / Finance on the Stock page and the ops digest; no count needed.
- Low-stock alert from the pack minimum, the same as every other item.
- Monthly quick check in the stocktake mode (Delivery 3): consumables show as OK / Low / Out, no numbers.
- Later (not now): usage-based depletion from job materials and prebuild ratios (10 x 4m conduit used means about 40 saddles), suggested by the AI and confirmed by a person, once a few months of job data exist. Logged in `docs/IDEAS_BACKLOG.md` item 22.

No weekly manual adjustment is needed.

## Hand-over from the UX review (20 Oct 2026)

The laptop chat owns every purchase order, supplier bill, stock, price list and tools change from here (this plan). The cloud chat's UX deliveries 4 to 6 drop the items below; fold them into the PO deliveries wherever they fit (numbers are `docs/UX_REVIEW.md` items, each has the file and lines):

- **UX 101. Supplier and Stock pages load queries one after another** (public/supplier-detail.html 41-68)
- **UX 121. PO list defaults to All and loads every PO ever** (public/purchase-orders.html 49, 70-73, 126-148)
- **UX 125. 'Match to Stock' is a native dropdown of every material, per line** (public/supplier-detail.html 343, 366-369, 632-635)
- **UX 126. Van and warehouse counts: tap the Qty cell instead of a PO or full edit form** (public/vehicle-stock.html 48-53, 64-122)
- **UX 128. Price lists: every Apply or Keep reloads five queries and redraws the page** (public/price-lists.html 79-82, 120-158, 129, 135, 172-188)
- **UX 134. No confirmation or email step after creating a PO** (public/purchase-orders.html 324-325)
- **UX 135. PO status words are inconsistent and 'Needs approval' is misleading** (public/purchase-orders.html 41, 95, 135)
- **UX 136. Bills can be approved in two places with different rules** (public/supplier-detail.html 126-131, 162-166)
- **UX 137. 'Review in full' strands you on the supplier page** (public/supplier-bills.html 206-220)
- **UX 139. 'Not a price list' has no confirm and cannot be undone** (public/price-lists.html 109-117, 136)
- **UX 140. 'Supplier lists' tab is really the price search** (public/price-lists.html 52-55, 122-126, 160-170)
- **UX 146. Stock picker needs the quantity first, then closes on every tap** (public/js/supabase-client.js 4338-4392)

Already shipped by UX delivery 3 on 20 Oct 2026, do not redo: UX 36 Receive all on job POs (`receiveAllPoLines`, one `po_receive_line` call per line), UX 47 PO suggestions with a tick box per stock line taking stock through `po_create_stock_pull` per stage, UX 71 Create PO supplier required except stock pulls (`flagRequiredField`), UX 72 blank unit cost blocks the save (`materialLineRowsProblem`), UX 73 Where from keeps typed lines, UX 80 PO line rows fit a phone (`.pml-lbl`). Shared helpers now in `supabase-client.js` for the PO work: `showToast`, `openModal` (`poOverlay` wraps it), `friendlyError`, `flagRequiredField` / `clearFieldFlags`, `materialLineRowsProblem`.

Stays with the cloud chat: the rest of the UX deliveries (navigation, speed, invoicing and Xero, office pages other than the above, login, chat, inbox, settings, HR) and the booking-with-open-tasks change (plan in the cloud chat, waiting on the owner's yes).
