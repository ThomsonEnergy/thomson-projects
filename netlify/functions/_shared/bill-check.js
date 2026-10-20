// Checks a supplier bill against its PO, line by line (spec A11c, migration 20261019030000).
//
// Issues a bill can have (supplier_bills.check_issues, each { kind, text, ... }):
//   no_po              the bill is not linked to a PO
//   not_on_po          a line that is not on the linked PO
//   price_higher       a line charged more than the PO price (over 1%)
//   over_quantity      more billed for a PO line, across every bill on that PO, than was ordered
//   po_total_exceeded  every bill on the PO together comes to more than the PO (over 2%)
//   duplicate_number   another bill from the same supplier has the same number
//   possible_duplicate another bill from the same supplier, same amount, within 3 days
// check_status: matches (nothing wrong), no_po (only that), problems, or it stays queried /
// resolved once a person has dealt with it (the issues are still refreshed).
// Line amounts are ex-GST on both sides (bill lines and PO lines), so totals compare like for like.

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// INV-0103, inv103 and INV 103 are the same number
const normNum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(inv|invoice)/, '').replace(/^0+/, '');
const qty = (n) => Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 2 });
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

async function checkBill(admin, billId) {
  const { data: bill } = await admin.from('supplier_bills').select('*').eq('id', billId).maybeSingle();
  if (!bill) return null;
  const { data: lines } = await admin.from('supplier_bill_line_items').select('*').eq('bill_id', bill.id);
  const issues = [];
  let poClosed = false;

  // duplicates among our own bills from this supplier
  if (bill.supplier_id) {
    const { data: others } = await admin.from('supplier_bills').select('id, bill_number, amount, bill_date').eq('supplier_id', bill.supplier_id).neq('id', bill.id);
    const num = normNum(bill.bill_number);
    (others || []).forEach(o => {
      if (num && normNum(o.bill_number) === num) {
        issues.push({ kind: 'duplicate_number', other_bill_id: o.id, text: `Bill ${bill.bill_number} is in TEops twice` });
      } else if (Math.abs((Number(o.amount) || 0) - (Number(bill.amount) || 0)) < 0.01 && bill.bill_date && o.bill_date
        && Math.abs(new Date(o.bill_date) - new Date(bill.bill_date)) <= 3 * 86400000) {
        issues.push({ kind: 'possible_duplicate', other_bill_id: o.id, text: `Same amount (${money(bill.amount)}) as bill ${o.bill_number || '(no number)'} from ${o.bill_date}: entered twice?` });
      }
    });
  }

  if (!bill.po_id) {
    issues.push({ kind: 'no_po', text: 'Not linked to a PO' });
  } else {
    const { data: po } = await admin.from('purchase_orders').select('id, po_number, po_type, budget_cap, received, closed_at').eq('id', bill.po_id).maybeSingle();
    const { data: poLineRows } = await admin.from('purchase_order_line_items').select('id, description, quantity, unit_cost').eq('po_id', bill.po_id);
    if (po) po.purchase_order_line_items = poLineRows || [];
    poClosed = !!po?.closed_at;
    const poLines = po?.purchase_order_line_items || [];
    const { data: poBills } = await admin.from('supplier_bills').select('id').eq('po_id', bill.po_id);
    const billIds = (poBills || []).map(b => b.id);
    const { data: allLines } = billIds.length ? await admin.from('supplier_bill_line_items').select('bill_id, po_line_item_id, quantity, unit_cost').in('bill_id', billIds) : { data: [] };

    (lines || []).forEach(l => {
      if (!l.po_line_item_id) { issues.push({ kind: 'not_on_po', line_id: l.id, text: `"${l.description}" (${qty(l.quantity)} x ${money(l.unit_cost)}) is not on ${po?.po_number || 'the PO'}` }); return; }
      const pl = poLines.find(p => p.id === l.po_line_item_id);
      if (!pl) return;
      if (Number(l.unit_cost) > Number(pl.unit_cost) * 1.01 + 0.005) {
        issues.push({ kind: 'price_higher', line_id: l.id, text: `"${l.description}" charged ${money(l.unit_cost)} each, ${po.po_number} says ${money(pl.unit_cost)} (${money((l.unit_cost - pl.unit_cost) * l.quantity)} more)` });
      }
    });

    // quantities across every bill on this PO
    const billedByPoLine = {};
    (allLines || []).forEach(l => { if (l.po_line_item_id) billedByPoLine[l.po_line_item_id] = (billedByPoLine[l.po_line_item_id] || 0) + (Number(l.quantity) || 0); });
    const mine = new Set((lines || []).map(l => l.po_line_item_id).filter(Boolean));
    poLines.filter(pl => mine.has(pl.id)).forEach(pl => {
      const billed = billedByPoLine[pl.id] || 0;
      if (billed > (Number(pl.quantity) || 0) + 0.001) {
        issues.push({ kind: 'over_quantity', po_line_id: pl.id, text: `"${pl.description}": ${qty(billed)} billed across ${billIds.length > 1 ? 'the bills on ' : ''}${po.po_number}, only ${qty(pl.quantity)} ordered` });
      }
    });

    const poTotal = po?.po_type === 'open' && po.budget_cap ? Number(po.budget_cap) : poLines.reduce((s, p) => s + (Number(p.quantity) || 0) * (Number(p.unit_cost) || 0), 0);
    const billedTotal = (allLines || []).reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0);
    if (poTotal > 0 && billedTotal > poTotal * 1.02 + 0.01) {
      issues.push({ kind: 'po_total_exceeded', text: `Bills on ${po.po_number} come to ${money(billedTotal)} ex GST, the PO is ${money(poTotal)}` });
    }
  }

  const real = issues.filter(i => i.kind !== 'no_po');
  let status = real.length ? 'problems' : (bill.po_id ? 'matches' : 'no_po');
  if (['queried', 'resolved'].includes(bill.check_status) && status !== 'matches') status = bill.check_status;
  const update = { check_status: status, check_issues: issues, checked_at: new Date().toISOString() };
  // matches a PO that is already closed (the approval step): approved for payment, pay on the later of the
  // supplier's terms date and today (same rule as closing the PO)
  const { data: sup } = bill.supplier_id ? await admin.from('suppliers').select('needs_review').eq('id', bill.supplier_id).maybeSingle() : { data: null };
  if (status === 'matches' && poClosed && !bill.paid && !bill.approved_for_payment && !sup?.needs_review) {
    const today = sydneyToday();
    Object.assign(update, { approved_for_payment: true, approved_at: update.checked_at, pay_on: bill.due_date && bill.due_date > today ? bill.due_date : today });
  }
  await admin.from('supplier_bills').update(update).eq('id', bill.id);
  return { status, issues };
}

// Every bill on a PO is checked again when one of them changes (quantities add up across bills).
async function checkBillAndSiblings(admin, billId) {
  const r = await checkBill(admin, billId);
  const { data: bill } = await admin.from('supplier_bills').select('po_id').eq('id', billId).maybeSingle();
  if (bill?.po_id) {
    const { data: siblings } = await admin.from('supplier_bills').select('id').eq('po_id', bill.po_id).neq('id', billId);
    for (const s of siblings || []) await checkBill(admin, s.id);
  }
  return r;
}

module.exports = { checkBill, checkBillAndSiblings, normNum, sydneyToday };
