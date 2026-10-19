# Business Facts

Last updated 19 Oct 2026

Facts the owner has confirmed, which the code and spec depend on. Update here when they change.

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

- `/js` and `/css` are cached for 10 minutes, so bump `?v=` on every changed file reference. Unversioned scripts (theme.js, template-questions.js, formbay-advice-parser.js, vendor/supabase-2.js) can lag up to 10 minutes after a deploy.
- **DB cleanup:** 51 per-row `auth.uid()` RLS policies, 105 duplicate permissive policies and 135 unindexed FKs (worst: time_entries, projects, job_tasks). Do this before time_entries or activity_log reach tens of thousands of rows. New work must not add to the debt: see the fast RLS rules in CLAUDE.md, and run the Supabase performance advisor after DDL.
- **Supabase JS library:** 43 pages load the floating `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, and a local copy exists at `public/js/vendor/supabase-2.js`. Switch to self-hosting immediately if an upstream release ever breaks the app.
- **Large files:** splitting project.html (458 KB) and supabase-client.js (299 KB) is low priority.

## Images

- **Committed images:** resize static images in `public/` to the largest size they're shown at (about 1200px long edge for half-page quote photos). Use JPEG via mozjpeg q~78, or PNG via palette quantisation.
- **Uploads:** every upload goes through `compressImage()`. Use the defaults for site photos, and `compressImage(file, DOC_IMAGE_MAX, DOC_IMAGE_QUALITY)` (2560px / 0.85) for paperwork.
- **Thumbnails:** use `supaImageVariant()` at display time.
- **Exceptions:** email attachments, meeting audio and generated PDFs are uploaded untouched on purpose.
