-- Migration 018 — Standalone invoices (no job/quote) and quote-less jobs
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Invoices can now exist without a stage/job -----------------------------
-- A standalone invoice bills a client directly for something with no
-- quote or job behind it - a one-off charge, a callout, etc.

alter table invoices alter column cost_centre_id drop not null;
alter table invoices add column if not exists client_id uuid references clients(id);
alter table invoices add column if not exists description text;

-- A standalone invoice must have a client to bill even without a job;
-- a job-linked invoice gets its client via the job instead.
alter table invoices drop constraint if exists invoices_client_or_stage_check;
alter table invoices add constraint invoices_client_or_stage_check
  check (cost_centre_id is not null or client_id is not null);

-- Standalone invoices bill a client directly (no project in between), so
-- the Xero contact cache lives on clients too, alongside the existing
-- one on projects.
alter table clients add column if not exists xero_contact_id text;

-- 2. Rebuild the token-lookup function to handle both cases ---------------

create or replace function get_invoice_by_token_v2(p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  -- Job-linked invoice - full itemized breakdown + claim history, as before.
  select jsonb_build_object(
    'invoice', to_jsonb(inv) - 'xero_invoice_id' - 'xero_invoice_status' - 'created_by',
    'cost_centre', jsonb_build_object('id', cc.id, 'name', cc.name, 'quoted_amount', cc.quoted_amount, 'stc_total', cc.stc_total),
    'project', jsonb_build_object(
      'name', p.name, 'job_number', p.job_number, 'client_name', p.client_name,
      'client_address', p.client_address, 'client_email', p.client_email
    ),
    'client', jsonb_build_object('client_type', cl.client_type),
    'line_items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost, 'sort_order', li.sort_order
      ) order by li.sort_order), '[]'::jsonb)
      from cost_centre_line_items li where li.cost_centre_id = cc.id
    ),
    'company', to_jsonb(cs),
    'previous_claims', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'invoice_number', i2.invoice_number, 'labour_amount', i2.labour_amount,
        'material_amount', i2.material_amount, 'stc_amount', i2.stc_amount, 'sent_at', i2.sent_at
      ) order by i2.sent_at), '[]'::jsonb)
      from invoices i2 where i2.cost_centre_id = cc.id and i2.sent_at < inv.sent_at
    )
  )
  into result
  from invoices inv
  join cost_centres cc on cc.id = inv.cost_centre_id
  join projects p on p.id = cc.project_id
  left join clients cl on cl.id = p.client_id
  cross join company_settings cs
  where inv.invoice_token = p_token and inv.cost_centre_id is not null and cs.id = 1;

  if result is not null then
    return result;
  end if;

  -- Standalone invoice - no stage, no job, no claim history. Client comes
  -- straight from invoices.client_id instead of via a project.
  select jsonb_build_object(
    'invoice', to_jsonb(inv) - 'xero_invoice_id' - 'xero_invoice_status' - 'created_by',
    'cost_centre', jsonb_build_object('name', coalesce(inv.description, 'Invoice'), 'quoted_amount', null, 'stc_total', 0),
    'project', jsonb_build_object(
      'name', null, 'job_number', null, 'client_name', cl.name,
      'client_address', cl.address, 'client_email', cl.email
    ),
    'client', jsonb_build_object('client_type', cl.client_type),
    'line_items', '[]'::jsonb,
    'company', to_jsonb(cs),
    'previous_claims', '[]'::jsonb
  )
  into result
  from invoices inv
  left join clients cl on cl.id = inv.client_id
  cross join company_settings cs
  where inv.invoice_token = p_token and inv.cost_centre_id is null and cs.id = 1;

  return result;
end;
$$;

-- 3. Quote-less jobs ---------------------------------------------------------
-- A job created directly, with no quote/proposal step at all - matches how
-- Time & Materials already behaves (straight to job_booked, quote_number
-- stays null forever since there was never a quote to number). No schema
-- change needed here - projects.quote_number and job_number are already
-- both nullable, and the existing approval trigger already assigns a job
-- number the moment pipeline_stage is set to job_booked or later. This
-- entry just documents that a project row with quote_number null and
-- proposal_template = 'direct_job' represents exactly this case.
