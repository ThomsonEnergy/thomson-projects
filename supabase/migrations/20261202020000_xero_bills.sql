-- Supplier bills to Xero (H4, item 83 part C, 13 Nov 2026).
--
-- An approved supplier bill is pushed to Xero as an AUTHORISED Bill (ACCPAY) by the push-bills-to-xero
-- worker (every 15 minutes, on while api_keys xero_bills_push = 'on') or by Push to Xero on the supplier
-- page; a credit note as a supplier credit note (ACCPAYCREDIT) allocated to its PO's bills in Xero. The
-- invoice PDF goes up as the Xero attachment. Payments are not pushed: the bank feed matches them in Xero.
-- The account codes come from xero_account_mapping (Settings > Xero Mapping): the purchase rows are
-- seeded here with no code, so nothing is pushed until the owner picks the accounts.

alter table public.supplier_bills
  add column if not exists xero_bill_id text,
  add column if not exists xero_bill_number text,
  add column if not exists xero_bill_status text,
  add column if not exists xero_bill_error text,
  add column if not exists xero_pushed_at timestamptz,
  add column if not exists xero_tried_at timestamptz;

alter table public.suppliers add column if not exists xero_contact_id text;

insert into public.xero_account_mapping (category, label, xero_account_code, xero_tax_type)
select v.category, v.label, '', 'INPUT'
from (values
  ('purchase_materials', 'Materials bought (supplier bills)'),
  ('purchase_contractor', 'Subcontractors (contractor bills)'),
  ('purchase_freight', 'Freight and delivery on supplier bills'),
  ('purchase_tools', 'Tools and equipment bought')
) as v(category, label)
where not exists (select 1 from public.xero_account_mapping m where m.category = v.category);
