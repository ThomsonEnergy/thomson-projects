-- Migration 020 — Fix invoice number drawing from server-side functions,
-- fix the direct_job proposal_template check constraint
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Server-side number drawing, without the user-session check ----------
-- get_next_number() checks is_pricing_role() against auth.uid() - correct
-- when called directly from the browser (e.g. new-project.html drawing a
-- quote number), but auth.uid() is empty when called via the service-role
-- client from our own Netlify functions, since there's no user session in
-- that context. Those callers already checked the user's role one layer
-- up (requirePricingRole/requireAdmin) before ever reaching this, so this
-- version skips the redundant (and here, always-failing) check. Same
-- atomic UPDATE...RETURNING as the original - no race condition risk.

create or replace function get_next_number_serverside(counter_name text)
returns int
language plpgsql
security definer
as $$
declare
  next_val int;
begin
  if counter_name = 'quote' then
    update company_settings set next_quote_number = next_quote_number + 1
      where id = 1 returning next_quote_number - 1 into next_val;
  elsif counter_name = 'job' then
    update company_settings set next_job_number = next_job_number + 1
      where id = 1 returning next_job_number - 1 into next_val;
  elsif counter_name = 'invoice' then
    update company_settings set next_invoice_number = next_invoice_number + 1
      where id = 1 returning next_invoice_number - 1 into next_val;
  else
    raise exception 'Unknown counter: %', counter_name;
  end if;

  return next_val;
end;
$$;

-- 2. Allow 'direct_job' as a valid proposal_template ------------------------
-- A job created with no quote at all (see dashboard.html's "New job - no
-- quote" button) needs its own proposal_template value distinct from the
-- existing quote-based templates.

alter table projects drop constraint if exists projects_proposal_template_check;
alter table projects add constraint projects_proposal_template_check
  check (proposal_template in ('new_build', 'solar', 'quick_estimate', 'time_and_materials', 'direct_job'));
