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
- Invoices: `push-invoice-to-xero.js`, `update-invoice-in-xero.js`, payload in `_shared/build-xero-invoice-payload.js`. Credit notes: `push-credit-note-to-xero.js`. Timesheets: `push-timesheets-to-xero.js`. Employees: `sync-employee-to-xero.js`. Webhook (invoice paid, Invoices topic): `xero-webhook.js`.
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

## Open questions for the owner / accountant
Real account codes; whether a company's STC credit is netted on the sales invoice or treated as a separate purchase with its own tax invoice; whether Formbay's documents are recipient-created tax invoices (then the app must not issue its own for the same sale); GST timing at assignment versus sale; cash vs accrual BAS.
