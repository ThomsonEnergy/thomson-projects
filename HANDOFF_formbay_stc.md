# Handoff: Formbay + STCs (STC page, job STC tab, Formbay job creation)

Written for a fresh chat to pick up. Read `README.md`, `PROJECT_SPEC.md`, `SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md` too.
Decided in a long conversation with the owner (Jasper). Phase 0 and Phase 1 are built (see "Progress" at the end); Phases 2 to 4 are still a plan.

## Ground rules (apply to everything)
- Hard rule from the owner: never use em dashes anywhere (chat, code, comments, docs).
- Work in your git worktree, then `git fetch origin && git rebase origin/main && git push origin HEAD:main`. Other chats push to main too.
- Migrations: next free number is above 147 (re-check `ls Migrations` after fetching). Apply with the Supabase MCP (`apply_migration`, project id `ziakpklnzkbbjjnqgkmz`), save the `.sql` in `Migrations/`, add a row to `Migrations/migration_audit_diagnostic.sql`.
- Check JavaScript with `node --check` (for pages, extract the inline `<script>` first). No test suite.
- Pages load `/js/supabase-client.js?v=NN` (currently 66) and `/css/style.css?v=NN` (15). Bump on every page when you change those files.
- Never enter credentials for the owner and do not ask for passwords in chat. Do not download files without asking. Ask before production data changes. Tax rules are for the owner's accountant, not for you to decide.

## What the owner wants (in their words, tidied)
1. A page in the app listing STCs: totals, what is pending, what is sold, etc.
2. A tab on each solar project showing its STCs, where we can import what they sold for and handle the variance.
3. Create the Formbay job from our app, assign the installer, and do as much as possible from our app.

## Agreed plan (phases)
- **0** Formbay login test (built, see below) and the Xero change-over (another chat: `HANDOFF_xero_live_switch.md`).
- **1** STC records, the job tab and the STC page with manual entry of the sale. Also fix the STC line on customer invoices (see the Xero handoff).
- **2** Automatic pull from Formbay: job status and sale info, plus copies of Formbay's invoice and tax invoice on the job.
- **3** Posting the settlement (gain, fee, GST) to Xero. Needs the accountant's method first.
- **4** Create and submit Formbay jobs from the app (validate first; a person always presses Submit, as it is an installer declaration).

Proposed STC page (pricing roles only): tiles for STCs awaiting sale, sold-not-paid, the STC asset balance at the booked price (default $35, per quote), expected value at an editable market price, unrealised gain, "GST to set aside" (about 1/11 of unpaid STC credits); a job list filtered by Not lodged / Pending installer / Pending retailer / Pending CER audit / Approved for sale / Sold / Paid; select several jobs to record one Formbay remittance (Formbay may pay in batches, to be confirmed).
Proposed data: a `job_stcs`-style table per solar job (project, stc_count, booked_price, customer type, GST on the credit, status, formbay_form_id, sell_date, sell price per STC, fees, gross, net remitted, formbay invoice number and links, variance, Xero document ids, settled_at).

## What already exists in the app
- Stage-level STC calculator on quotes: `cost_centres.stc_total`, `stc_system_kw`, `stc_zone_rating` (1.382 default), `stc_install_year`, `stc_price_per_certificate` (default $35 from Settings). See the stage editor in `public/project.html` / `public/new-project.html`.
- `projects.formbay_lodgement_status` set BY HAND on the job (Handover section): pending_installer_action, pending_retailer_action, pending_cer_audit, approved_for_sale, sold. `public/js/supabase-client.js` (~line 3043) uses it in the handover checklist.
- Solar compliance checklist: `netlify/functions/_shared/solar-compliance-rules.js`, migration 108.
- API key `formbay` in `api_keys` (set, but see below, it does not log in to the Server API). The older `netlify/functions/test-formbay-connection.js` targets a different host (`api.formbay.com.au`, OAuth2) and never confirmed a login.
- **Built this session:** `netlify/functions/test-formbay-trading.js` plus a card in Settings > API Keys ("Test Formbay trading API", live and test-site buttons). Read-only: logs in, lists solar jobs, installers, electricians, and inspects the newest solar job for `sell_info`. Never returns customer names or addresses.

## Formbay Server API facts (from https://trading.formbay.com.au/formbay/documentation, a Swagger page with the spec embedded in the HTML)
- Host `https://trading.formbay.com.au`. A separate test site exists: `https://cert-trading.formbay.com.au` (use it for anything that writes).
- Login: `POST /formbay/token` form body with `username` + `password`, or `basic_token`. Returns `access_token`, `refresh_token`, `expires_in`, `user_id`. Then `Authorization: Bearer`. A bad login returns HTTP 200 with the body `false` (not an error code).
- No webhooks or callbacks anywhere in the documented API, and nothing for remittances, payments or settlements. Polling only.
- STC sale data: `GET /client_api/get_jobs?ftype=...&formid=...` returns a `sell_info` block: `sellDate`, `sellPrice`, `stcPrice`, `stcCount`, `invoiceNumber`, `invoiceUrl`, `taxInvoiceUrl`, `fees {stc, cer, gst}`, `soldby`. The documented example is a battery (ftype `bstc`); whether solar (PV) jobs carry it is UNCONFIRMED, which is what the test button checks.
- Lists: `/client_api/pv_form_list` (job ids, optional `group_id`), `/client_api/bstc_form_list` (supports `last_update` unix timestamp for incremental polling), `/client_api/pv_installers`, `pv_electricians`, `pv_designers`, `clients`, panel/inverter/battery brand and model lists.
- Create/submit a solar job: `POST /client_api/create_form` (JSON) or `POST /client_api/pv_form` (form) with owner details (ofname, osname, ophone, omobile, oemail, ostreet..., ostate), property details (pstreet..., ppostalcode), `nmi`, `iid` (installer id), `eid` (electrician id), `did` (designer id), panel brand/model/count, inverter brand/model/series, `ratedpower`, `idate`, `deemingperiod`, `rrebate`, `rsolarcredits`, `commercial`, etc.; `POST /client_api/pv_validate_job` and `pv_submit_job` (both take `formid`); documents via `pv_doc` / `pv_docs_list`; `GET /client_api/pv_form_docs`, `forms_docs_zip`; battery via `POST /jobs/battery_submit`. Also `POST /client_api/pv_recs_calculator`.
- Formbay also offers a Python SDK at `/formbay/download_sdk` (about 139 KB). Not downloaded: needs the owner's permission. It would show exactly how the login token is formed.

## Where it is stuck (do this first)
The owner ran "Test live Formbay". Result: the saved key as `basic_token`, and base64 of it, both returned `false`, so the saved key is not valid for this API. Next: the owner needs proper Server API credentials from Formbay support (ask for API access and a basic token, or use an account login). They can paste a basic token, or `username:password` (colon between), into Settings > API Keys > Formbay API Key; saving overwrites the old value (empty boxes are skipped). Then re-run the test and read the `get_jobs` section to see whether solar jobs carry `sell_info`. Also run the test-site button if they have separate credentials.

## Accounting facts you need (full detail in `HANDOFF_xero_live_switch.md`)
Job $11,000 inc GST with 50 STCs credited at $35 ($1,750): the customer pays $9,250 (individual) or $9,075 (company, credit is $1,925 inc GST). Formbay pays $1,950 GST-free (individual) or $2,145 inc GST (company), less a $50 inc GST fee. The booked $35 is held as an asset until Formbay pays; the difference is "STC trading variance". The tax method is the accountant's call.

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

## Open questions for the owner
Do Formbay's invoices act as the tax invoice for the sale (so the app must not issue its own)? Is the booked price always $35? Start with solar only (batteries and hot water later)? Where are installers' CEC accreditation numbers and Formbay IDs kept (needed to assign installers when creating jobs)?

## Progress (2026-10-14), supersedes "Where it is stuck" and parts of the Formbay facts above
- **Formbay login works.** It is NOT the trading site's `/formbay/token`. It is OAuth2 password grant: `POST https://oauth2.formbay.com.au/token`, header `Authorization: Basic <API key exactly as shown in Formbay > Settings > API Access>`, form body `grant_type=password&username=...&password=...&scope=admin`. Token lasts 86400 s. Settings > API Keys now has `formbay` (API key), `formbay_username`, `formbay_password`.
- With that token: `api.formbay.com.au/entrypoint` answers (returns the account identity link); on trading.formbay.com.au the installer/electrician lists answer but `auth_metadata` is 401 and `pv_form_list` was empty. The account is brand new with **zero jobs**, so whether jobs carry `sell_info` is still unknown. The account is flagged `fb2_enabled` (Formbay's newer system). `test-formbay-trading.js` now crawls `api.formbay.com.au` links read-only to map that API; api-doc.formbay.com.au was down for maintenance.
- **Formbay DOES have webhooks** (Formbay > Settings > Webhooks): events `job.created`, `job.updated`, `job.deleted`, `doc.updated`; custom header auth; it sends a `webhook.test` ping and only saves on HTTP 2xx. Receiver built: `netlify/functions/formbay-webhook.js` (checks header `X-Webhook-Secret` against api key `formbay_webhook_secret`, stores every event raw in `formbay_webhook_events`, migration 146). Payload format unknown until real jobs exist; processing not built.
- **Owner answers:** customers credited $35/STC; Formbay buys at usually $39.25 ($38 to $39.50); fee is $0.53 processing + $0.47 CER registration = $1.00 ex GST per STC ($1.10 inc), deducted from the payment. Payments come in batches. Solar, batteries and hot water all in scope. Commercial installs get 10% "GST on Units" added to the sale.
- **Formbay payment PDFs:** a "Payment Advice" (Reference No, one line per Formbay job: `PV|BSTC <formbay job id> (owner) [SPV status] [* Commercial Install] units $price GST total`) plus a fee "TAX INVOICE" numbered `FEE<reference>`. Cash received = advice Total minus fee invoice Total.
- **Phase 1 built:** migration 147 (`job_stcs`, `formbay_payment_advices` with generated `amount_received`, `formbay_payment_advice_lines`, `company_settings.stc_expected_sale_price` 39.25 and `stc_fee_per_certificate` 1.00; pricing roles only). Job page "STCs" tab (pricing roles, any job) to add/edit lines; it keeps `projects.formbay_lodgement_status` in step (least advanced line wins, paid counts as sold). New page `public/stcs.html` (nav "STCs", pricing only): tiles, status filter, expected price/fee settings, and **import of payment advice + fee invoice PDFs** read in the browser with pdf.js (cdnjs 3.11.174) and parsed by `public/js/formbay-advice-parser.js`; preview, match lines to jobs by Formbay job id, then save (marks matched lines paid). Shared helpers in `supabase-client.js`: `STC_TYPES`, `STC_STATUSES`, `stcCountForStage`, `stcFigures`. Also fixed: the job page never loaded the stage STC calculator inputs (added to `COST_CENTRE_COLS_PRICING`).
- Do NOT use `pdf-parse` server-side for these PDFs: it returned one file's text for another when several were read in the same process (it fails on some of these files too).
- **Still to do:** fix the STC line on customer invoices for company clients (see the Xero handoff); Phase 2 (process webhook events, pull job status and sale info); Phase 3 (post settlements to Xero, accountant's method first); Phase 4 (create and submit Formbay jobs, test site first).
