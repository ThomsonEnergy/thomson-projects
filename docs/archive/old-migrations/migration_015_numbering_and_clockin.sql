-- Migration 015 — Numbering (quotes/jobs/invoices) + multi-cost-centre clock-in
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Numbering counters, editable in Settings > Numbering ------------------

alter table company_settings add column if not exists next_quote_number int not null default 1000;
alter table company_settings add column if not exists next_job_number int not null default 7000;
alter table company_settings add column if not exists next_invoice_number int not null default 3000;
alter table company_settings add column if not exists invoice_number_prefix text not null default 'SI';

-- 2. Quote/job numbers on projects ------------------------------------------

alter table projects add column if not exists quote_number int;
alter table projects add column if not exists job_number int;

-- Cost centre numbers (e.g. "7000-1") are computed from the project's
-- job_number plus stage position, not stored — they'd need constant
-- upkeep if stages get reordered or added. The app computes them on the
-- fly wherever they're shown.

-- 3. Atomic "get next number" — avoids two people grabbing the same
-- number if they both create a quote at the same moment -------------------

create or replace function get_next_number(counter_name text)
returns int
language plpgsql
security definer
as $$
declare
  next_val int;
begin
  if not is_pricing_role() then
    raise exception 'Not authorized to draw a new number';
  end if;

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

-- 4. Multi-cost-centre selection at clock-in --------------------------------
-- When a staff member picks more than one cost centre for a single clock
-- in/out session, we don't yet know the split — cost_centre_id stays null
-- and the chosen set lives here instead, so the Split tool can offer just
-- those stages (not every stage on the job) with an even starting split.

alter table time_entries add column if not exists selected_cost_centre_ids uuid[];
