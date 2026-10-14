# Handoff: Xero - switch to the real company, new accounts, STC accounting

Written for a fresh chat to pick up. Read `README.md`, `PROJECT_SPEC.md` and the Xero parts of `SETUP.md` too.
This was decided in a long conversation with the owner (Jasper). Nothing in this file has been built yet unless it says so.

## Ground rules (apply to everything)
- Hard rule from the owner: never use em dashes anywhere (chat, code, comments, docs).
- Work in your git worktree, then `git fetch origin && git rebase origin/main && git push origin HEAD:main`. Other chats push to main too.
- Migrations: next free number is above 145 (re-check `ls Migrations` after fetching). Apply with the Supabase MCP (`apply_migration`, project id `ziakpklnzkbbjjnqgkmz`), save the `.sql` file in `Migrations/`, and add a row to `Migrations/migration_audit_diagnostic.sql`.
- Check JavaScript with `node --check` (for pages, extract the inline `<script>` first). There is no test suite.
- Pages load `/js/supabase-client.js?v=NN` (currently 64) and `/css/style.css?v=NN` (14). Bump the number on every page when you change those files.
- Never enter credentials for the owner. Ask before any destructive or production data change. Do not guess at tax rules: flag them for the owner's accountant.

## Goal
1. Move the Xero integration from the demo company to the owner's real company.
2. Create a new chart of accounts section so this app's postings are separate from the old ServiceM8 (SM8) postings.
3. Fix how STC (solar certificate) credits are posted and shown (below).

## How Xero is wired
- Xero **Custom Connection** (client_credentials), one organisation. `netlify/functions/_shared/xero-client.js` fetches a token each call. Keys live in the `api_keys` table: `xero_client_id`, `xero_client_secret`, `xero_webhook_key` (all currently set, belonging to the DEMO company).
- Invoices: `push-invoice-to-xero.js`, `update-invoice-in-xero.js`, payload in `_shared/build-xero-invoice-payload.js`. Credit notes: `push-credit-note-to-xero.js`. Timesheets: `push-timesheets-to-xero.js`. Employees: `link-employee-to-xero.js` (links to existing Xero employees only, never creates; see SETUP.md). Webhook (invoice paid, Invoices topic): `xero-webhook.js`.
- Settings screens: Settings > API Keys, Settings > Xero Mapping (account mapping table plus the "Xero connection" card with IDs and "Look up IDs from Xero", backed by `lookup-xero-ids.js` and `get-xero-chart-of-accounts.js`).
- `xero_account_mapping` has 5 rows (all demo codes): `labour` 2002 OUTPUT, `materials` 2001 OUTPUT, `stc_credits_individual` 2003 EXEMPTOUTPUT, `stc_credits_company` 2004 OUTPUT, `stc_trading_variance` 2005 OUTPUT.
- Xero tax type codes are the API codes (OUTPUT, EXEMPTOUTPUT, OUTPUT2...), not the labels in Xero's screens.

## Part A: switching to the real company
The owner does these in Xero (steps were given to them): create the new accounts first, create a Custom connection for the real organisation (needs an org admin to approve, paid plan), tick accounting (transactions, contacts, settings) and payroll (employees, timesheets, settings) scopes, add the Invoices webhook at `https://projects.thomsonenergy.com.au/.netlify/functions/xero-webhook`, then paste the 3 keys into Settings > API Keys. Pasting a key into the box overwrites the stored one (blank boxes are left alone).

**Do NOT clear anything until the owner says the real keys are in.** Then clear the demo links (the demo footprint is small):
- `profiles.xero_employee_id` (1 row), plus `xero_payroll_status` / `xero_payroll_error`
- `time_entries.xero_pushed_at` (5 rows marked pushed, which would otherwise never go to the real Xero)
- `company_settings`: `xero_tracking_category_id`, `xero_ordinary_earnings_rate_id`, `xero_ot1_earnings_rate_id`, `xero_ot2_earnings_rate_id`, `xero_public_holiday_earnings_rate_id`, `xero_laha_earnings_rate_id`, `xero_payroll_calendar_id`
- `clients.xero_contact_id`, `projects.xero_contact_id`, `invoices.xero_invoice_id` / `xero_invoice_status`, `credit_notes.xero_credit_note_*` (all zero rows today, but re-check, as new data may exist by then)
Then the owner presses "Look up IDs from Xero", fills the IDs, and repoints the 5 mappings at the new accounts. Finish with a small test: one invoice (labour + materials lines), one timesheet, mark the invoice paid in Xero and confirm the webhook updates the app.

## Part B: proposed new accounts (owner to choose real codes)
Names are suggestions; keep "(Projects App)" in them so they are separate from SM8: Sales - Labour, Sales - Materials, STC Credits - Individual, STC Credits - Company, STC Trading Variance (all Sales type), plus a **current asset** "STC Receivable (Formbay)" and an expense "STC Trading Fees". Check each account's allowed tax types in Xero (an asset account may refuse "GST on Income").

## Part C: STC accounting (the decided logic; accountant to confirm the tax points)
Worked example, job $10,000 + $1,000 GST = $11,000, 50 STCs credited at $35.

**Individual customer:** credit $1,750, no GST on it. Customer pays $9,250. GST on the invoice stays $1,000 (the STC credit is part of the consideration). Formbay later pays $1,950 (50 x $39) GST-free credit, charges a $50 inc GST fee, remits $1,900.
**Company customer:** credit $1,925 inc GST ($1,750 + $175). Customer pays $9,075. Formbay pays $2,145 ($1,950 + $195 GST) less the $50 fee = $2,095.

Recommended Xero coding (to be confirmed by the accountant):
- Customer invoice: labour and materials lines with GST, then a negative "STC assigned" line to the STC Receivable asset account. Individual: BAS Excluded. Company: with GST (nets the GST to $825 on the invoice).
- Formbay settlement: the sale clears the $1,750 asset and puts the difference ($200 at $39) to STC Trading Variance; the fee is $45.45 plus $4.55 GST claimable; one bank deposit matches both Formbay documents. For a company the sale carries $195 GST.

**Known issue to fix:** the Xero push already posts the STC line using the mapping's tax type with `LineAmountTypes` unset (exclusive). For company clients that makes Xero total $9,075 (correct) but the app's quote page, invoice page and balance due subtract a flat STC amount for everyone, so they show $9,250. The quote/invoice pages (`public/quote.html`, `public/invoice.html`, `get_invoice_by_token_v3`, `get_quote_by_token`) need the client type and should show $1,925 inc GST for companies. Also the STC lines currently post to income accounts (negative income, shows as a negative GST-free sale on the BAS): switch to the asset account.

**Decisions made:**
- Owner's idea to split the customer invoice so GST on the STC part is invoiced later was analysed and NOT adopted for now. For individuals Formbay's credit is GST-free, so splitting would permanently remove about $159 GST per job, not defer it; for companies the netted invoice already defers it. If the accountant approves a different timing, build it as a per-company setting ("GST on STC portion: on invoice / on sale"), not hard-wired.
- Owner said not to bother with a written accountant brief for now.
- STC tracking, the STC page and the Formbay side are handled by another chat (see `HANDOFF_formbay_stc.md`). Coordinate on the asset account and the settlement postings (Phase 3 there needs your Xero pieces).

## How Formbay actually pays (from 3 real payments the owner shared, 14 Oct 2026)
Each sale produces two PDFs with matching numbers: a **Payment Advice** (reference N) and a **Tax Invoice - Fees** (invoice FEEN). The bank deposit is the advice total less the fee invoice total.
- **Batches:** one advice can cover several jobs (417171 paid PV 1269150, 61 STCs, and PV 1268818, 87 STCs, together). Each job is its own line with its STC count. So settlement must split one deposit across jobs.
- **Price:** $39.25 per STC in Sept/Oct 2026 ($39.30 in Dec 2024), against the $35 booked price, so roughly $4.25 per STC variance.
- **GST on the sale:** residential jobs show "-" for GST on units (GST-free). A job flagged "* Commercial Install" adds 10% GST on units (315309: 365 x $39.30 = $14,344.50 + $1,434.45 GST = $15,778.95). Formbay's trigger is its own "Commercial Install" flag, so the app's company/individual client type must line up with it.
- **Fees:** not a flat amount. $0.53 STC processing + $0.47 CER registration = $1.00 per STC + GST, so $1.10 per STC inc GST, on every sale.
- **Batteries** come through the same way (description "BSTC <form id>", 465 STCs in 64112).
- The advice is titled "Payment Advice", not "Recipient Created Tax Invoice". **Decided by the owner (14 Oct 2026):** we do NOT issue our own tax invoice to Formbay; the advice shows the GST correctly and the BAS is done from it. The app must never create a sales invoice to Formbay for an STC sale.
- The advices also print the owner's bank details. Do not store or log those.

Worked example, 417171: gross $5,809.00, fees 148 x $1.10 = $162.80, deposit $5,646.20. Booked value at $35: $5,180.00, so the variance is $629.00. Suggested Xero posting (accountant to confirm): one Receive Money of $5,646.20 with lines STC Receivable 2003 $5,180.00 (BAS Excluded), STC Trading Variance 2003-1 $629.00, STC Trading Fees 2003-2 -$148.00 + GST, which matches the bank feed line in one go.

## Real Xero accounts (created by the owner in the real company, 14 Oct 2026)
2001 Material Sales, 2002 Labour Sales, 2003 STC Receivable (Current Asset), 2003-1 STC Trading Variance (Sales), 2003-2 STC Trading Fees (Expense). One receivable account for both client types; the tax type is set per line by the mapping (individual BAS Excluded, company GST on Income).

## Open questions for the owner / accountant
Real account codes; whether a company's STC credit is netted on the sales invoice or treated as a separate purchase with its own tax invoice; whether Formbay's documents are recipient-created tax invoices (then the app must not issue its own for the same sale); GST timing at assignment versus sale; cash vs accrual BAS.
