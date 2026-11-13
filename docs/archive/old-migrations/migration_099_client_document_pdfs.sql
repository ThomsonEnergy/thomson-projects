-- Migration 099: real, saved PDFs for quotes and invoices, matching what
-- was already done for signed onboarding documents. Renders the existing
-- client-facing quote.html/invoice.html pages via headless Chromium
-- (see generate-client-document-pdf-background.js) - same page a client
-- already sees via their link, same stage/claim/payment-link content -
-- with a shared title/cover page (pdf-cover-page.js) prepended.
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

alter table projects add column if not exists quote_pdf_path text;
alter table projects add column if not exists quote_pdf_generated_at timestamptz;
alter table projects add column if not exists quote_pdf_error text;
alter table invoices add column if not exists pdf_path text;
alter table invoices add column if not exists pdf_generated_at timestamptz;
alter table invoices add column if not exists pdf_error text;
