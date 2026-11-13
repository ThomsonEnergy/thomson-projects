-- Migration 034 — Supplier matching fields + background extraction jobs
-- Run this in Supabase: SQL Editor > New query > paste > Run.

-- 1. Real-world invoices proved name/logo matching is unreliable - the
-- same MMEM account (Haymans, Greentech, TLE) shows different logos but
-- an identical "Charge To" account number. Matching hierarchy going
-- forward: their account number for us > our ABN match > their bank
-- details > business name, only as a last resort.

alter table suppliers add column if not exists our_account_number text;
alter table suppliers add column if not exists abn text;

-- 2. Background extraction jobs - pricelists and statements can take
-- longer than a normal function's ~10s limit, so those run as Netlify
-- Background Functions instead (up to 15 minutes) and write their result
-- here. The frontend polls this row rather than waiting on one request.

create table if not exists ai_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('pricelist', 'statement')),
  status text not null default 'pending' check (status in ('pending', 'complete', 'failed')),
  result jsonb,
  error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table ai_extraction_jobs enable row level security;
drop policy if exists "Users manage their own extraction jobs" on ai_extraction_jobs;
create policy "Users manage their own extraction jobs" on ai_extraction_jobs
  for all using (created_by = auth.uid() or is_pricing_role()) with check (created_by = auth.uid() or is_pricing_role());
