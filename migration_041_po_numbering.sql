-- Migration 041 — Purchase order numbering
-- Run this in Supabase: SQL Editor > New query > paste > Run.

alter table company_settings add column if not exists next_po_number int not null default 2000;
alter table company_settings add column if not exists po_number_prefix text not null default 'PO';
alter table purchase_orders add column if not exists po_sequence_number text;

-- Extend the existing atomic counter functions rather than adding a
-- parallel system - same pattern already used for quote/job/invoice.

create or replace function get_next_number(counter_name text)
returns int
language plpgsql
security definer
as $$
declare
  next_val int;
begin
  if not is_pricing_role() then
    raise exception 'Not authorized';
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
  elsif counter_name = 'po' then
    update company_settings set next_po_number = next_po_number + 1
      where id = 1 returning next_po_number - 1 into next_val;
  else
    raise exception 'Unknown counter: %', counter_name;
  end if;

  return next_val;
end;
$$;

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
  elsif counter_name = 'po' then
    update company_settings set next_po_number = next_po_number + 1
      where id = 1 returning next_po_number - 1 into next_val;
  else
    raise exception 'Unknown counter: %', counter_name;
  end if;

  return next_val;
end;
$$;
