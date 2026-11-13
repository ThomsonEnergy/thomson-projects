-- Migration 100 — Credit notes
--
-- New "Issue credit note" feature (Bugs & Updates board, approved 7 Sept
-- 2026): correcting an invoice after it's been pushed to Xero. Xero
-- rejects line-item edits on an AUTHORISED invoice via the API ("Invoice
-- not of valid status for modification") - push-invoice-to-xero.js has
-- created every invoice as AUTHORISED (not Draft) since migration/commit
-- 75d1c3f, so the existing "Edit invoice > Save & push to Xero" flow no
-- longer works once an invoice has actually been pushed. A credit note is
-- the real, Xero-supported way to correct or dispute an already-pushed
-- invoice - reduce what's still owed (account credit) or, if it's already
-- been paid, record that money was refunded back to the client outside
-- Xero (this app doesn't move money itself).
--
-- Mirrors invoices/invoice_claims' shape closely on purpose, so the same
-- mental model (one header row, one row per cost-centre claimed) applies
-- and the same created_at-based ordering convention (see migration 081)
-- keeps working without a second ordering rule to maintain.

create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  reason text,
  -- false = account credit (reduces this invoice's balance due, and frees
  -- up the credited amount to be claimed again on a future invoice for
  -- the same stage). true = the money was actually refunded back to the
  -- client outside Xero/this app - refund_reference is just a note of how
  -- (bank transfer ref, Airwallex refund ID, etc), not something this app
  -- executes itself.
  refund boolean not null default false,
  refund_reference text,
  xero_credit_note_id text,
  xero_credit_note_number text,
  xero_credit_note_status text,
  xero_credit_note_error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table credit_note_claims (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id) on delete cascade,
  cost_centre_id uuid not null references cost_centres(id) on delete cascade,
  labour_amount numeric(12,2) not null default 0,
  material_amount numeric(12,2) not null default 0,
  stc_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create index credit_notes_invoice_id_idx on credit_notes(invoice_id);
create index credit_note_claims_credit_note_id_idx on credit_note_claims(credit_note_id);
create index credit_note_claims_cost_centre_id_idx on credit_note_claims(cost_centre_id);

-- Credit notes reverse money already recorded (and can represent a real
-- refund) - Finance/Admin only, tighter than the general Sales-inclusive
-- is_pricing_role() gate invoicing itself uses. is_finance_role() already
-- exists (migration 083, finance-role timesheet management) - reused as-is.
alter table credit_notes enable row level security;
create policy "Finance/Admin manage credit notes" on credit_notes
  for all using (is_finance_role()) with check (is_finance_role());

-- Open to any authenticated user, same as invoice_claims (migration 055) -
-- stageClaimSummary() in project.html needs to read these regardless of
-- role to keep the hours/labour-budget bars staff already see accurate,
-- the same way it already reads invoice_claims today.
alter table credit_note_claims enable row level security;
create policy "staff full access on credit_note_claims"
  on credit_note_claims for all to authenticated using (true) with check (true);

-- Thread credit notes through get_invoice_balance_due() - the single
-- source of truth for "what does this invoice owe" (migration 023) - so a
-- credited invoice's own balance due (and therefore what "Pay online"
-- charges, and what the client-facing page shows) drops by the credited
-- amount. Reuses calculate_balance_due() rather than re-deriving the GST
-- formula a second time, same discipline that function's own comment
-- calls for.
create or replace function get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
as $$
declare
  inv record;
  credited record;
begin
  select labour_amount, material_amount, stc_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) as stc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  return calculate_balance_due(
    inv.labour_amount - credited.labour,
    inv.material_amount - credited.material,
    inv.stc_amount - credited.stc
  );
end;
$$;

-- Thread credit notes into get_invoice_by_token_v3()'s "claimed_before"
-- figures too, so the client-facing invoice page's own claimed/remaining
-- breakdown for OTHER stages/invoices in the sequence stays consistent
-- with what staff see internally (stageClaimSummary, updated separately
-- in project.html). Ordered by credit_notes.created_at, matching the
-- created_at (not sent_at) convention migration 081 established.
create or replace function get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_company jsonb;
  v_project jsonb;
  v_claims jsonb := '[]'::jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_balance numeric;
  v_is_standalone boolean;
  v_project_id uuid;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  select to_jsonb(cs) - 'id' into v_company from company_settings cs where id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_email', p.client_email
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_email', c.email)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'stc_amount', ic.stc_amount,
      'claimed_before', coalesce((
        select sum(x.amt) from (
          select ic2.labour_amount + ic2.material_amount as amt
          from invoice_claims ic2 join invoices i2 on i2.id = ic2.invoice_id
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.created_at < v_invoice.created_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
            and not exists (select 1 from invoice_claims ic3 where ic3.invoice_id = i3.id)
          union all
          select -(cnc.labour_amount + cnc.material_amount)
          from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
          where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
        ) x
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb)
    ) order by cc.sort_order)
    into v_claims
    from invoice_claims ic join cost_centres cc on cc.id = ic.cost_centre_id
    where ic.invoice_id = v_invoice.id;
  elsif v_invoice.cost_centre_id is not null then
    select jsonb_build_array(jsonb_build_object(
      'cost_centre_id', cc.id,
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'stc_total', coalesce(cc.stc_total, 0),
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
      ), 0),
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object('description', li.description, 'quantity', li.quantity, 'unit_cost', li.unit_cost) order by li.sort_order)
        from cost_centre_line_items li where li.cost_centre_id = cc.id
      ), '[]'::jsonb)
    ))
    into v_claims
    from cost_centres cc where cc.id = v_invoice.cost_centre_id;
  end if;

  if not v_is_standalone then
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', i.invoice_number,
      'sent_at', i.sent_at,
      'amount', i.labour_amount + i.material_amount
    ) order by i.sent_at), '[]'::jsonb)
    into v_previous
    from invoices i
    where i.id <> v_invoice.id
      and coalesce(i.project_id, (select cc.project_id from cost_centres cc where cc.id = i.cost_centre_id)) = v_project_id
      and i.created_at < v_invoice.created_at;
  end if;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice) || jsonb_build_object('balance_due', v_balance),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;

grant execute on function get_invoice_by_token_v3(uuid) to anon, authenticated;
grant execute on function get_invoice_balance_due(uuid) to anon, authenticated;
