-- Migration 087 — Clear TFN/bank/super data collected before the Xero-native-onboarding switch
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- TFN, bank account, and super fund details are no longer collected by
-- this app at all - handled entirely through Xero's own native employee
-- self-onboarding invite instead (see onboarding.html, settings.html,
-- sync-employee-to-xero.js). This is a one-time data cleanup, not a
-- schema change: clears whatever was collected under the old approach
-- for every existing employee, so nothing stale/unmaintained lingers in
-- this app once everyone's actually re-entered it through Xero.
--
-- This is a deliberate, one-off data-clearing statement, not something
-- to re-run - once applied there's nothing left here to clear again.

update profiles set
  tax_file_number = null,
  bank_account_name = null,
  bank_bsb = null,
  bank_account_number = null,
  super_is_self_managed = false,
  super_fund_name = null,
  super_fund_abn = null,
  super_member_number = null,
  smsf_abn = null,
  smsf_bank_bsb = null,
  smsf_bank_account = null,
  smsf_esa = null;
