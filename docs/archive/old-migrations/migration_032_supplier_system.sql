-- Migration 032 — Supplier system: directory, itemized POs, credit terms
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Suppliers - a real directory, not just a free-text name on bills ------
-- Credit terms are structured (not free text) so a due date - and
-- therefore "overdue" - can actually be calculated, not just displayed.

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_email text,
  contact_phone text,
  credit_terms_type text not null default 'net_days' check (credit_terms_type in ('cod', 'net_days', 'eom_days')),
  credit_terms_days int not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

alter table suppliers enable row level security;
drop policy if exists "Pricing roles manage suppliers" on suppliers;
create policy "Pricing roles manage suppliers" on suppliers
  for all using (is_pricing_role()) with check (is_pricing_role());

-- Computes the actual due date for a bill, from its date and the
-- supplier's credit terms - cod = due same day, net_days = date + N days,
-- eom_days = N days after the end of the month the bill fell in (the
-- common AU trade-credit "30 days EOM" pattern).
create or replace function calculate_bill_due_date(p_bill_date date, p_credit_terms_type text, p_credit_terms_days int)
returns date
language plpgsql
as $$
begin
  if p_bill_date is null then
    return null;
  end if;
  if p_credit_terms_type = 'cod' then
    return p_bill_date;
  elsif p_credit_terms_type = 'eom_days' then
    return (date_trunc('month', p_bill_date) + interval '1 month - 1 day')::date + p_credit_terms_days;
  else
    return p_bill_date + p_credit_terms_days;
  end if;
end;
$$;

-- 2. Materials get a real supplier reference -------------------------------
-- The old free-text supplier column stays (existing data, and a fallback
-- for materials with no structured supplier yet) - supplier_id is used
-- going forward wherever a real link is needed (auto-generating POs).

alter table materials add column if not exists supplier_id uuid references suppliers(id);

-- 3. Purchase orders - itemized, two types ----------------------------------
-- Fixed: locked once sent, everything decided up front. Open: starts
-- empty, any staff member can add items as the job progresses, optional
-- budget cap to flag a blowing estimate before it's a surprise.

alter table purchase_orders add column if not exists supplier_id uuid references suppliers(id);
alter table purchase_orders add column if not exists po_type text not null default 'fixed' check (po_type in ('fixed', 'open'));
alter table purchase_orders add column if not exists budget_cap numeric;
alter table purchase_orders add column if not exists locked boolean not null default false;
alter table purchase_orders add column if not exists approved_for_payment boolean not null default false;
alter table purchase_orders add column if not exists approved_by uuid references profiles(id);
alter table purchase_orders add column if not exists approved_at timestamptz;

create table if not exists purchase_order_line_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  material_id uuid references materials(id),
  description text not null,
  quantity numeric not null default 1,
  unit_cost numeric not null default 0,
  added_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table purchase_order_line_items enable row level security;
drop policy if exists "Everyone can view PO line items" on purchase_order_line_items;
create policy "Everyone can view PO line items" on purchase_order_line_items for select using (true);
drop policy if exists "Everyone can add PO line items" on purchase_order_line_items;
create policy "Everyone can add PO line items" on purchase_order_line_items
  for insert with check (auth.uid() is not null);
drop policy if exists "Pricing roles edit or remove PO line items" on purchase_order_line_items;
create policy "Pricing roles edit or remove PO line items" on purchase_order_line_items
  for update using (is_pricing_role()) with check (is_pricing_role());
drop policy if exists "Pricing roles delete PO line items" on purchase_order_line_items;
create policy "Pricing roles delete PO line items" on purchase_order_line_items
  for delete using (is_pricing_role());

-- 4. Supplier bills - link to suppliers properly, add due date --------------

alter table supplier_bills add column if not exists supplier_id uuid references suppliers(id);
alter table supplier_bills add column if not exists due_date date;
alter table supplier_bills add column if not exists approved_for_payment boolean not null default false;

-- Flags on a bill's own line items when they don't match an approved PO,
-- or the charged price is higher than the PO expected - exactly what the
-- supplier detail page's "needs attention" list reads from.
alter table supplier_bill_line_items add column if not exists po_line_item_id uuid references purchase_order_line_items(id);
alter table supplier_bill_line_items add column if not exists flag_reason text;

-- 5. Statements - the end-of-month AI-reconciled upload ---------------------

create table if not exists supplier_statements (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id),
  statement_date date,
  total_amount numeric not null default 0,
  file_path text,
  reconciliation_notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table supplier_statements enable row level security;
drop policy if exists "Pricing roles manage statements" on supplier_statements;
create policy "Pricing roles manage statements" on supplier_statements
  for all using (is_pricing_role()) with check (is_pricing_role());

-- 6. Per-supplier financial summary - the three totals plus overdue -------
-- Powers both the main Suppliers list (aggregated across all) and each
-- supplier's own detail page (filtered to just that one).

create or replace function get_supplier_financial_summary(p_supplier_id uuid default null)
returns table(
  supplier_id uuid, invoiced_not_paid numeric, approved_for_payment numeric,
  not_approved numeric, overdue numeric
)
language plpgsql
security definer
as $$
begin
  return query
  select
    sb.supplier_id,
    coalesce(sum(case when not sb.paid then sb.amount else 0 end), 0) as invoiced_not_paid,
    coalesce(sum(case when not sb.paid and sb.approved_for_payment then sb.amount else 0 end), 0) as approved_for_payment,
    coalesce(sum(case when not sb.paid and not sb.approved_for_payment then sb.amount else 0 end), 0) as not_approved,
    coalesce(sum(case when not sb.paid and sb.due_date is not null and sb.due_date < current_date then sb.amount else 0 end), 0) as overdue
  from supplier_bills sb
  where (p_supplier_id is null or sb.supplier_id = p_supplier_id)
    and sb.supplier_id is not null
  group by sb.supplier_id;
end;
$$;
