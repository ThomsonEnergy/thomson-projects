-- Migration 111 - Client ABN
--
-- Adds a real ABN field to clients, so it can be filled from the ABN
-- Lookup business-name search (abn-lookup.js, already built and proxying
-- abr.business.gov.au - previously only ever wired up in the description
-- text under Settings, never actually built into a form) rather than
-- typed in and hoped to be right. Confirms the client's actual
-- registered legal name at the same time, since the search returns the
-- ABR's own entity name alongside the ABN.

alter table clients add column if not exists abn text;
