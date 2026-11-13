-- STC tracking: the certificates each job creates, where they are up to with Formbay, what they sold
-- for, and the Formbay payment advices that paid for them.
--
-- job_stcs: one row per Formbay job (a job can have more than one, e.g. solar plus a battery).
--   stc_type: pv (solar), bstc (battery), swh (hot water). booked_price is what the customer was credited
--   per STC on the quote (normally $35). Status follows Formbay's stages, then sold and paid.
--   Sale details come from the payment advice line once imported (formbay_payment_advice_lines.job_stc_id),
--   or can be typed in by hand (sale_price, sold_on).
-- formbay_payment_advices: one row per Formbay "Payment Advice" (Reference No) with its matching fee tax
--   invoice ("FEE" + reference). Formbay usually pays several jobs in one advice. Cash received is the
--   advice total less the fee invoice total.
-- formbay_payment_advice_lines: one row per job on the advice, matched to job_stcs by Formbay job id.
--
-- company_settings: expected Formbay sale price and fee per STC, used for the "expected" figures before a
-- job is sold.
--
-- Pricing roles only (is_pricing_role(), migration 007), like the rest of the money side.

create table if not exists job_stcs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  stc_type text not null default 'pv' check (stc_type in ('pv', 'bstc', 'swh')),
  stc_count integer not null default 0 check (stc_count >= 0),
  booked_price numeric not null default 35,
  formbay_job_id text,
  status text not null default 'not_lodged' check (status in (
    'not_lodged', 'pending_installer_action', 'pending_retailer_action', 'pending_cer_audit',
    'approved_for_sale', 'sold', 'paid')),
  commercial boolean not null default false,
  sale_price numeric,
  sold_on date,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_stcs_project_idx on job_stcs (project_id);
create index if not exists job_stcs_formbay_job_idx on job_stcs (formbay_job_id);
create index if not exists job_stcs_status_idx on job_stcs (status);

create table if not exists formbay_payment_advices (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique,
  advice_date date,
  units integer,
  net_total numeric,
  gst_on_units numeric not null default 0,
  total numeric,
  fee_invoice_no text,
  fee_ex_gst numeric not null default 0,
  fee_gst numeric not null default 0,
  fee_total numeric not null default 0,
  amount_received numeric generated always as (coalesce(total, 0) - coalesce(fee_total, 0)) stored,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists formbay_payment_advice_lines (
  id uuid primary key default gen_random_uuid(),
  advice_id uuid not null references formbay_payment_advices(id) on delete cascade,
  job_stc_id uuid references job_stcs(id) on delete set null,
  stc_type text check (stc_type in ('pv', 'bstc', 'swh')),
  formbay_job_id text,
  description text,
  units integer not null default 0,
  unit_price numeric,
  gst_on_units numeric not null default 0,
  total numeric,
  sort_order integer not null default 0
);
create index if not exists formbay_payment_advice_lines_advice_idx on formbay_payment_advice_lines (advice_id);
create index if not exists formbay_payment_advice_lines_job_stc_idx on formbay_payment_advice_lines (job_stc_id);

alter table company_settings add column if not exists stc_expected_sale_price numeric not null default 39.25;
alter table company_settings add column if not exists stc_fee_per_certificate numeric not null default 1.00;

alter table job_stcs enable row level security;
alter table formbay_payment_advices enable row level security;
alter table formbay_payment_advice_lines enable row level security;

drop policy if exists "pricing roles on job_stcs" on job_stcs;
create policy "pricing roles on job_stcs" on job_stcs for all to authenticated
  using (is_pricing_role()) with check (is_pricing_role());
drop policy if exists "pricing roles on formbay_payment_advices" on formbay_payment_advices;
create policy "pricing roles on formbay_payment_advices" on formbay_payment_advices for all to authenticated
  using (is_pricing_role()) with check (is_pricing_role());
drop policy if exists "pricing roles on formbay_payment_advice_lines" on formbay_payment_advice_lines;
create policy "pricing roles on formbay_payment_advice_lines" on formbay_payment_advice_lines for all to authenticated
  using (is_pricing_role()) with check (is_pricing_role());
