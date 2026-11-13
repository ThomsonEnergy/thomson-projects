-- Data fix, 13 Nov 2026 (item 83 part A, owner's yes "build all"). Production, one transaction.
-- 1. Tradezone M94930 ($718.79, no PO number, saved against PO2009 on 11 Nov by a preselected guess):
--    the customer paid it directly, not ours. Removed; its emailed card put aside with the reason.
--    Nothing from it was received or added to PO2009 (its ten lines were still undecided).
-- 2. O'Connors C604083: the packing slip was saved as the bill ($39.45 typed, one $0 line) against PO2015
--    and the real invoice marked a duplicate. The packing-slip bill is removed, its card becomes a packing
--    slip (filed with the invoice when that is saved), and the invoice card is back To check against PO2015.
-- 3. M92798 on PO2009 re-checked by hand: with M94930 gone the PO's bills ($628.80 ex) equal the PO, its
--    three lines are Added to PO, lines inc GST $691.68 vs the bill's $691.67: matches.
begin;

-- 1. M94930
delete from public.supplier_bills where id = '3abfe988-a7ea-4850-9d7a-fa0b7469bc1f' and bill_number = 'M94930' and not paid;
update public.supplier_bill_inbox
   set status = 'not_a_bill', bill_id = null, po_id = null, match_confidence = 'none',
       match_reason = 'Paid by the customer directly, not ours (owner, 13 Nov 2026). Was saved against PO2009 by mistake and removed.',
       resolved_at = now()
 where bill_id = '3abfe988-a7ea-4850-9d7a-fa0b7469bc1f' or (extracted->>'bill_number' = 'M94930' and supplier_id = '8786022f-f4b5-4da3-b322-88eacc3f2be9');
insert into public.activity_log (entity_type, entity_id, action, description)
values ('supplier', '8786022f-f4b5-4da3-b322-88eacc3f2be9', 'bill_removed', 'Bill M94930 ($718.79) removed: paid by the customer directly, not ours (owner, 13 Nov 2026). It had been saved against PO2009 by a preselected guess, no PO number on it.'),
       ('purchase_order', '6fea7cbe-baf0-4012-bd67-5b5a9af07d9f', 'bill_removed', 'Bill M94930 ($718.79) taken off this PO: paid by the customer directly, not ours (owner, 13 Nov 2026). Its ten lines were never on the PO.');

-- 2. C604083
delete from public.supplier_bills where id = 'dc35c4ab-fec5-4bea-99c2-8baec57146ab' and bill_number = 'C604083' and not paid;
update public.supplier_bill_inbox
   set status = 'not_a_bill', bill_id = null, po_id = null, match_confidence = 'none',
       match_reason = 'Packing slip C604083: nothing to pay. It is filed with the invoice when that is saved.',
       extracted = extracted || '{"document_type": "delivery_docket"}'::jsonb, resolved_by = null, resolved_at = null
 where id = '86fd0663-e6fe-4bb3-a7c4-e8b36c46bc49';
update public.supplier_bill_inbox
   set status = 'to_check', duplicate_of_bill_id = null, bill_id = null, po_id = '2b7f1568-dc8a-41eb-b4d8-8fcb464172d2', match_confidence = 'confident',
       match_reason = 'PO2015 is on the bill (supplier matched by account number). The packing slip from the same email was saved as this bill by mistake on 12 Nov; that is undone, save this one.',
       resolved_by = null, resolved_at = null
 where id = '7a7d305b-acbf-4adc-b8bb-50d5022b2608';
insert into public.activity_log (entity_type, entity_id, action, description)
values ('supplier', 'f34ee536-5345-4e00-aefe-126805ce531a', 'bill_removed', 'Bill C604083 removed: the packing slip had been saved as the bill ($39.45, one $0 line). The tax invoice is back on the Emailed bills page to save against PO2015 (13 Nov 2026).'),
       ('purchase_order', '2b7f1568-dc8a-41eb-b4d8-8fcb464172d2', 'bill_removed', 'Bill C604083 taken off this PO: it was the packing slip, saved by mistake. The tax invoice is on the Emailed bills page to save here (13 Nov 2026).');

-- 3. M92798 re-checked by hand (same rules as _shared/bill-check.js with M94930 gone)
update public.supplier_bills set check_status = 'matches', check_issues = '[]'::jsonb, checked_at = now()
 where id = '62406aac-1ee2-4a67-a7c6-8fccda13e653' and bill_number = 'M92798';

commit;
