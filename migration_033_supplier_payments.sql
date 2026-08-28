-- Migration 033 — Supplier payments via Airwallex
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Supplier bank details - needed to pay them at all -----------------------

alter table suppliers add column if not exists bank_account_name text;
alter table suppliers add column if not exists bsb text;
alter table suppliers add column if not exists bank_account_number text;
alter table suppliers add column if not exists airwallex_beneficiary_id text;

-- 2. Payment batches - one Airwallex transfer can cover several bills for
-- the same supplier due around the same time, so bills reference a
-- payment batch rather than each carrying their own transfer ID.

create table if not exists supplier_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  total_amount numeric not null default 0,
  airwallex_transfer_id text,
  status text not null default 'pending' check (status in ('pending', 'in_approval', 'paid', 'failed')),
  initiated_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table supplier_payments enable row level security;
drop policy if exists "Pricing roles manage supplier payments" on supplier_payments;
create policy "Pricing roles manage supplier payments" on supplier_payments
  for all using (is_pricing_role()) with check (is_pricing_role());

alter table supplier_bills add column if not exists payment_id uuid references supplier_payments(id);
