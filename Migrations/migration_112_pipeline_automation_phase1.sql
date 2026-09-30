-- Migration 112 - Job pipeline automation, phase 1
--
-- First slice of automating the pipeline_stage board (previously 100%
-- manual - every stage past job_booked/archived only ever got set by a
-- human picking it from the dashboard.html dropdown). This phase covers
-- quote approval through to job_booked: quote_approved -> deposit_paid
-- (or straight to the task check if no deposit is required) ->
-- awaiting_action/ready_to_book -> job_booked once actually scheduled.
--
-- is_deposit lets the payment webhooks (xero-webhook.js,
-- airwallex-webhook.js) tell "this specific paid invoice is the deposit
-- that unblocks the job" apart from a later stage-claim or final
-- invoice, without guessing off the description text.

alter table invoices add column if not exists is_deposit boolean not null default false;

-- Widens the existing pipeline_stage check constraint to add the stages
-- this phase (and the two still to come) need: quote_sent (between
-- draft_quote and quote_approved - "Email quote to client" clicked),
-- awaiting_action (between deposit_paid and ready_to_book - mandatory
-- tasks outstanding), and ready_to_invoice/complete (client_handover and
-- awaiting_payment's eventual neighbours - added now so the board and
-- its manual dropdown have somewhere to put a card by hand even before
-- their own automatic triggers land in a later phase).
alter table projects drop constraint if exists projects_pipeline_stage_check;
alter table projects add constraint projects_pipeline_stage_check
  check (pipeline_stage = any (array[
    'lead', 'draft_quote', 'quote_sent', 'quote_approved', 'deposit_paid',
    'awaiting_action', 'ready_to_book', 'job_booked', 'job_not_complete',
    'client_handover', 'ready_to_invoice', 'awaiting_payment', 'complete', 'archived'
  ]));
