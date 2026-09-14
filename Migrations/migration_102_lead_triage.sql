-- Migration 102 — Lead triage rework
--
-- Every contactable lead used to auto-create a full quote-track project
-- (proposal_template 'new_build') the instant it landed, with the raw
-- captured JSON dumped straight into sow_text as its "scope of works" -
-- not readable, and it forced every lead down the quote path regardless
-- of what they actually need (an urgent switchboard repair should become
-- a job directly, not a quote). Replacing that with an explicit triage
-- step on the Leads page itself: an AI-generated plain-English summary of
-- what the enquiry actually is, and three conversion buttons (Create job/
-- quote/estimate) that make the project only once staff decide what kind
-- it should be.

drop trigger if exists on_lead_created on leads;
drop function if exists create_project_from_lead();

alter table leads add column ai_summary text;
alter table leads add column ai_summary_generated_at timestamptz;
