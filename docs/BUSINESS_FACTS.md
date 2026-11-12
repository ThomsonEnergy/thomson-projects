# Business Facts

Last updated 12 Nov 2026

Facts the owner has confirmed, which the code and spec depend on. Update here when they change.

## Where we work

- Licensed in **NSW and QLD only**, not the ACT (owner, 23 Oct 2026). Anything that covers areas (retail plan suggestions, networks) is limited to the NSW and QLD networks: Essential Energy, Ausgrid, Endeavour Energy, Energex and Ergon Energy.

## Xero

- TEops works only with **Thomson Energy Australia Pty Ltd** (Ultimate 20 plan, with Employment Hero and Airwallex connected). Never connect to or post anything for Thomson Energy Solutions Pty Ltd (Ignite plan). Confirmed 14 Oct 2026.
- Real account codes:

  | Code | Account |
  |---|---|
  | 2001 | Material Sales |
  | 2002 | Labour Sales |
  | 2003 | STC Receivable |
  | 2003-1 | STC Trading Variance |
  | 2003-2 | STC Trading Fees |

- The owner is the bookkeeper. Tax, super and STP classification is their (or their accountant's) call: explain the options, don't decide.

## Suppliers

- Suppliers are matched on ID details, never the business name alone: our account number with them, then ABN, then bank details. A name is only a suggestion to check. Confirmed 19 Oct 2026.
- **MMEM (Haymans and Greentech):** MMEM owns several stores and we have two accounts with them, one called Greentech and one called Haymans. Either account can buy from any MMEM store (Haymans or Greentech), so the store on the bill means nothing. **Only our account number on the bill says which account it is: Greentech 248045, Haymans 246153** (an invoice from either store can be on either account). They share an ABN and bank details. MMEM is the only supplier that works like this; everyone else goes off ABN. Coded in `matchSupplier()` (`_shared/supplier-bill-intake.js`) and `findMatchingSupplier()` (`supabase-client.js`): a shared ABN, bank account or account number never picks a supplier, a person does.
- Mailboxes: invoice@ is for supplier invoices, statements, credit notes and price lists only. Everything else goes to sales@. Suppliers must put our PO number on every invoice.

## Pay rates

- Each employee's rates are agreed in their employment contract. There are 4 rates: ordinary, 1.5x, 2x and 2.5x bands. These are set amounts, not calculated multiples.
- Rates are set in the app and pushed to Xero from the app, including after pay rises.
- Timesheets arrive in Xero Payroll as drafts and are approved there (owner, 26 Oct 2026). A timesheet deleted in Xero (pay run redone) is sent again by the next push; one still in Xero is never sent twice.
- Leave is requested and approved in the app (Timesheets page); approved leave goes to Xero Payroll as leave applications with the timesheet push (26 Oct 2026). Xero works out the leave hours from each person's ordinary hours.

## SAA accreditation classes (owner, 12 Nov 2026)

- Solar Accreditation Australia classes, and which job each one covers:
  - **GCBS** (grid connected battery systems): battery jobs. This is the one the federal battery discount and a battery quote need.
  - **GCPV** (grid connected PV): solar jobs.
  - **SAPS** (stand-alone power systems): off-grid jobs.
- Checks in the app match the class code in the licence name on Settings > Team, not the word "battery" or "solar". Jasper holds "Solar Accreditation Australia - GCPV & GCBS Design & Install (Full) Accreditation", valid to 30 Apr 2027.

## STCs and Formbay (confirmed 14 Oct 2026)

- **Customer credit:** customers are credited **$35 per STC** on the quote. Solar (PV), batteries (BSTC) and hot water are all in scope.
- **Sale price:** Formbay buys at usually **$39.25 per STC**. This fluctuates between $38 and $39.50, and is editable in the app.
- **Payment advices:** payments come in batches.
  - Formbay issues a Payment Advice: Reference No, date, and one line per Formbay job. Each line has the type (PV/BSTC) plus Formbay job id, owner name, SPV status, units, unit price, GST on units and total.
  - It also issues a matching fee tax invoice, "FEE<reference>".
- **Fee:** STC/CER Processing $0.53 plus CER Registration $0.47 = **$1.00 ex GST per STC** ($1.10 inc GST). The fee is deducted from the payment, so cash received = advice Total minus fee invoice Total.
- **GST on units:**
  - Commercial installs (customer registered for GST): Formbay adds 10% "GST on Units" to the sale.
  - Residential: no GST on units.
- **Matching:** match advice lines to jobs by Formbay job id. GST treatment and accounting method are still the accountant's call.

## Performance backlog (deferred, owner chose "later" on 16 Oct 2026)

- `/js` and `/css` are cached for 10 minutes, so bump `?v=` on every changed file reference. Unversioned scripts (theme.js, template-questions.js, formbay-advice-parser.js) can lag up to 10 minutes after a deploy.
- **DB cleanup:** 51 per-row `auth.uid()` RLS policies, 105 duplicate permissive policies and 135 unindexed FKs (worst: time_entries, projects, job_tasks). Do this before time_entries or activity_log reach tens of thousands of rows. New work must not add to the debt: see the fast RLS rules in CLAUDE.md, and run the Supabase performance advisor after DDL.
- **Supabase JS library:** every page loads the pinned local copy `public/js/vendor/supabase-2.js` (2.45.4) with `?v=` (since 19 Oct 2026, UX 93). To upgrade, replace the file with a newer UMD build and bump `?v=` on all 54 pages.
- **Large files:** splitting project.html (458 KB) and supabase-client.js (299 KB) is low priority.

## Images

- **Committed images:** resize static images in `public/` to the largest size they're shown at (about 1200px long edge for half-page quote photos). Use JPEG via mozjpeg q~78, or PNG via palette quantisation.
- **Uploads:** every upload goes through `compressImage()`. Use the defaults for site photos, and `compressImage(file, DOC_IMAGE_MAX, DOC_IMAGE_QUALITY)` (2560px / 0.85) for paperwork.
- **Thumbnails:** use `supaImageVariant()` at display time.
- **Exceptions:** email attachments, meeting audio and generated PDFs are uploaded untouched on purpose.

## Payment terms and late payment (9 Nov 2026)

- Quote T&Cs clause 5: deposit as quoted, final payment before commissioning, energisation or handover; a disputed invoice is paid for the undisputed part and disputed in writing within 5 days.
- Quote T&Cs clause 6: overdue amounts accrue interest at 21% per annum calculated daily; recovery costs (legal on a solicitor-client basis, collection, court, adjudication, administrative) are payable by the client.
- The invoice terms note (Settings > Payment Terms & T&Cs) says the same since 9 Nov 2026; before that it read 9% pa.
- **ServiceM8 Pay deposits in Xero (10 Nov 2026):** a deposit taken in ServiceM8 before any invoice lands in Xero as a prepayment, not an invoice (it shows in Sales > Invoices as INV-2003x, Awaiting Payment, no due date, the amount in the Paid column). It stays there until it is allocated. The way to close one when the job is in TEops: raise a deposit invoice in Xero by hand for the same amount and date (one line, Labour Income 2002, GST on Income), approve it, then open the prepayment and allocate it to that invoice. TEops holds the deposit as a paid ServiceM8 claim on the job (item 71) and its final invoice claims only the balance, so Xero and TEops agree without the deposit going through TEops. First done for Keith Murdock, J7016 / #4809, prepayment INV-20039 $3,436.31.
- In TEops, interest is charged per invoice (Charge interest on the invoice panel, item 66): shown as it accrues, quoted on reminders, and charged as a separate GST free interest invoice (Xero account 270 Interest Income, BAS excluded) so the original invoice never changes.
