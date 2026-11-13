-- Migration 152 - Public holiday paid as base + penalty
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- A public holiday's ordinary pay (1.0x) is owed whether or not the person
-- works it, so only the extra (the 2.5x rate minus the ordinary rate) is a
-- real job cost. Payroll now splits it:
--   * "Public holiday" base earnings rate (new column below): the person's
--     ordinary rate, posted to an overhead account. Paid for hours worked on
--     a public holiday AND, for full-time staff, 8 hours on a weekday public
--     holiday they did not work.
--   * The existing public holiday Jobs/Office earnings rates become the
--     penalty only (rate_2_5x - ordinary_rate).
-- public_holiday_pay_pushes records each unworked public holiday already
-- sent to Xero, so re-running a timesheet push never pays it twice. Written
-- only by push-timesheets-to-xero.js with the service role (no policies).

alter table company_settings add column if not exists xero_public_holiday_base_earnings_rate_id text;

create table if not exists public_holiday_pay_pushes (
  profile_id uuid not null references profiles(id) on delete cascade,
  holiday_date date not null,
  hours numeric not null,
  pushed_at timestamptz not null default now(),
  primary key (profile_id, holiday_date)
);
alter table public_holiday_pay_pushes enable row level security;
