-- Supplier or contractor, suppliers created from bills, and the ABN check on emailed bills
-- (spec A11a).
--
-- suppliers.kind: 'supplier' (goods) or 'contractor' (an outside business billing labour or
-- services). One list, filtered on the Suppliers page. Staff subcontractors stay on Team.
-- suppliers.needs_review: created automatically from a bill (or price list) and not opened and
-- saved by a person yet; bank details read off a bill are never trusted until then.
-- abn_* / gst_registered: what the ABN Lookup (abr.business.gov.au) says about the ABN.
-- supplier_bill_inbox.abn_check: the ABN Lookup check of the supplier details on each bill.

alter table public.suppliers
  add column if not exists kind text not null default 'supplier',
  add column if not exists needs_review boolean not null default false,
  add column if not exists created_from text,
  add column if not exists abn_legal_name text,
  add column if not exists gst_registered boolean,
  add column if not exists abn_checked_at timestamptz;

alter table public.suppliers drop constraint if exists suppliers_kind_check;
alter table public.suppliers add constraint suppliers_kind_check check (kind in ('supplier', 'contractor'));

alter table public.supplier_bill_inbox
  add column if not exists abn_check jsonb;
