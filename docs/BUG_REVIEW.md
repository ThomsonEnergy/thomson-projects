# Site bug review (19 Oct 2026)

Read-only review of the whole app (job page, quotes and sales, invoices and Xero, POs and stock, staff and time, inbox / chat / settings / AI) plus the Supabase security advisors. Nothing was changed. Items marked **(checked)** were confirmed by hand against the code or the live database. Fix status is tracked in `docs/DECISIONS.md`.

## S. Security (fix first)

**Fixed 19 Oct 2026 (migration 20261031000000, PR "Security fixes"):** S1 (policy; owner to confirm sign-ups are off), S2, S3, S4 (`sync-costs`, `create-jobs`, `_servicem8` deleted), S5, S6, S7, S8 (`escapeHtml` now also escapes quotes), S9, S10, S11, S12 (callback checks the Gmail address), S13, S14. Also found and fixed: the Stock page was blank on the live site (a variable clashed with a shared function name).

| # | Problem | Where |
|---|---|---|
| S1 | If Supabase sign-ups are on, anyone can sign up and make themselves Admin: the "insert own profile" policy does not limit role **(checked policy; sign-up setting needs the owner to check)** | profiles policy, `supabase/config.toml` |
| S2 | A staff member can make themselves Admin: their name is shown unescaped to admins (Home, Timesheets, profile), so a script in it runs as the admin | `js/staff-editor.js`, `home.html`, `timesheets.html` |
| S3 | `generate-sow` and `generate-scope` need no login: anyone online can spend the Anthropic key and have private job files summarised back **(checked)** | `netlify/functions/generate-sow.js`, `generate-scope.js` |
| S4 | `sync-costs` needs no login and overwrites stages' invoiced amounts (unused) | `sync-costs.js` |
| S5 | Database functions anyone can call with the public key: burn invoice / PO / job numbers (`get_next_number_serverside`), read labour costs, supplier balances, stage costs; old `accept_quote` **(checked)** | Supabase functions |
| S6 | Anyone with the public key can read every PO line price, stock count and material cost **(checked)** | RLS on `purchase_order_line_items`, `materials`, `material_stock_by_location` |
| S7 | Script injection (XSS) from outside: website lead form names, supplier names / bill lines from emailed PDFs, the signature field on the quote page **(checked lead form and signature)** | `leads.html`, `supplier-detail.html`, `suppliers.html`, `purchase-orders.html`, `stock.html`, `quote.html`, `accept-quote.js`, `accept-variation.js` |
| S8 | Script injection from staff text: Knowledge, Logs, Bugs pages, job activity log, task / stage / document names | `knowledge.html`, `logs.html`, `bugs.html`, `supabase-client.js` activity log, `project.html` |
| S9 | Client quote link returns the whole job row (internal notes, approval notes, installer summary, the job's own token); with a Direct Job's token, `accept-quote` archives the live job and clones it | `get_quote_by_token`, `accept-quote.js` |
| S10 | Staff can approve their own leave through the API; Finance's Approve button silently does nothing **(checked)** | leave_requests policies |
| S11 | Any logged-in user can reopen a closed PO or mark it approved for payment directly | purchase_orders policy |
| S12 | Gmail connect can be hijacked (state not tied to the browser); sales@ reconnect does not check it is sales@ | `google-oauth-start.js`, `google-oauth-callback.js` |
| S13 | Any staff can edit or delete someone's private emails once tagged to a job | migration 20261021020000 email policies |
| S14 | Staff browsers receive line item costs and labour $ (hidden on screen only) | `project.html` line items, `get-accrued-labour-cost.js` |

## M. Money and data wrong

**Fixed 19 Oct 2026 (migrations 20261101000000 and 20261101010000):** M1 to M19, and F8. Notes: M5 a never-sent (draft) quote can still be accepted from its link on purpose (a link can be shared by hand without emailing it); M12 a fully credited invoice is no longer marked paid (paid needs money received in Xero); M16 the quote's payment schedule now shows inc GST (milestones and deposit % still both come from the quote, unchanged).

| # | Problem | Where |
|---|---|---|
| M1 | Xero timesheet push loses hours at the pay-week edge (UTC range) and still marks them pushed: those hours are never paid **(checked)** | `push-timesheets-to-xero.js` |
| M2 | Dates default to UTC (yesterday before 10/11am): invoice date and due date (wrong BAS quarter on 1 July), Schedule staff, "back tomorrow" booking lands today, variation date | `project.html`, `create-invoice.js`, `supabase-client.js`, `timesheets.html` |
| M3 | Invoice project panel adds the STC credit instead of taking it off the "Total this claim" **(checked)** | `project.html` ~2176 |
| M4 | Two approvals at once (double tap, client + staff) make two jobs / two deposit invoices, or two variation stages | `create-job-from-quote.js`, `approve-variation.js` |
| M5 | Re-signing an approved quote overwrites the signature and approval method; a draft (never sent) quote can be accepted | `accept-quote.js`, `decline-by-client.js` |
| M6 | Moving a quote to Quote Approved on the Dashboard skips the real approval (no job, no deposit, half-job) | `dashboard.html` |
| M7 | Stock: Undo then Receive on a stock PO adds free stock; saving a material sets the Warehouse to the all-locations total; editing a received line leaves stock and job cost wrong; Undo after Move can lose Warehouse stock | migration 20261025000000, `stock.html`, `supabase-client.js` |
| M8 | "Generate PO suggestions" takes stock out again on every run, and for Staff takes it out without costing it to the job | `project.html` ~7081 |
| M9 | `create-invoice`: no server cap on claims, not all-or-nothing (orphan invoice on a part failure), invoiced amount read-then-write | `create-invoice.js` |
| M10 | Credit notes: negative parts make the app and Xero disagree; a credit on a paid invoice fails to allocate in Xero | `create-credit-note.js`, `push-credit-note-to-xero.js` |
| M11 | Airwallex pay link never refreshed after an invoice edit or credit; payment marked paid without checking the amount | `get-or-create-payment-link.js`, `airwallex-webhook.js` |
| M12 | Fully credited invoice may be marked paid by the Xero webhook (needs checking against Xero) | `xero-webhook.js` |
| M13 | Edit invoice ignores save errors (stage and invoice can disagree) | `project.html` ~2549 |
| M14 | STC credit GST uses the job's client type in the app but the bill-to client in Xero | `invoice_client_type`, `build-xero-invoice-payload.js` |
| M15 | Invoices list Outstanding / Overdue are ex GST and ignore credit notes | `invoices.html` |
| M16 | Quote page shows the deposit ex GST but it is invoiced inc GST; milestones shown but deposit % charged | `quote.html`, `create-job-from-quote.js` |
| M17 | 0% markup read as 45% for labour cost: signed variation stages show too much profit | `project.html` 2819, 3208 |
| M18 | PO tab Total counts a whole other job's PO when one line was moved in | `project.html` ~6991 |
| M19 | Job made from a quote loses prebuild grouping, payment milestones and the signature on its rebuilt quote PDF | `create-job-from-quote.js` |

## F. Features not working as intended

| # | Problem | Where |
|---|---|---|
| F1 | Variations tab and Details "Variations" card share one id: the tab can show the wrong list with no buttons, the card stays "Loading..." **(checked)** | `project.html` 3351, 3519 |
| F2 | "Pull from Warehouse" POs always fail (supplier name blank but required) **(checked)** | `vehicle-stock.html`, `purchase-orders.html` |
| F3 | Staff (non Admin / Finance / Sales) cannot create any PO (PO number needs a pricing role) | `supabase-client.js` drawNextPoNumber |
| F4 | Mark back ordered silently does nothing for Staff | `supabase-client.js` |
| F5 | Opening a past day on Schedule deletes that day's lead site inspection bookings | `schedule.html` 333 |
| F6 | Ticking a required task on My Day or Tasks never moves the job out of Awaiting Action; blocked ticks show "completed" | `my-day.html`, `tasks.html` |
| F7 | Clock out split across 2+ stages unbooks the job and skips "Complete" | `supabase-client.js` clock out |
| F8 | Jobs moved to Complete by hand are never archived (no completed date) | `archive-completed-jobs.js`, `dashboard.html` |
| F9 | Timesheet edit fails on shifts split at midnight ("finish must be after start") | `timesheets.html` |
| F10 | Double tap on Clock in makes two open entries | `my-day.html` |
| F11 | Inbox: a follow-up on our own sent email goes to ourselves; replies after an app-sent email lose threading | `inbox.html`, `send-gmail.js` |
| F12 | Text with a `"` (e.g. `Olex "TPS" 2.5mm`) is cut off when Edit quote / Edit stages saves | `project.html` editor |
| F13 | Duplicate as new quote drops the client link (makes a second client), stage, phone, milestones, rate tiers | `project.html` ~3874 |
| F14 | 5am digest says the email agent is down after quiet nights | `agent-log.js` |
| F15 | Supabase advisors: 4 security definer views, 29 functions without a fixed search path, leaked password protection off | Supabase |
