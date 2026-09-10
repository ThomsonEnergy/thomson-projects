-- Migration 098: a real, saved signed-document PDF per onboarding
-- signature, instead of only a plain-text snapshot + a drawn signature
-- image sitting separately in two columns. generate-signed-document.js
-- renders document_body_snapshot + the signature image + signer name/date
-- into a PDF (appending the Fair Work Information Statement for the
-- Employment Contract specifically, matching its own "please find
-- enclosed" clause) and stores it in the existing project-documents
-- bucket, recording the path here.
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

alter table onboarding_document_signatures add column if not exists file_path text;
alter table onboarding_document_signatures add column if not exists file_name text;
