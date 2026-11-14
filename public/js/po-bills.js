// The Bills fold on the PO page (purchase-order.html only, item 31; moved out of supabase-client.js
// 13 Nov 2026 to keep every page under its weight budget). The bills and credit notes on one PO
// with their lines (green on the PO, red to decide: Accept or Deny charge), Open invoice and Open
// docket, Move and Remove (js/supplier-bill-actions.js), Query supplier, the PO's next step
// (poNextStep), and Delete on a PO line that no bill charges for (item 88). Decisions go through
// supplier_bill_line_resolve and po_line_delete; the bill check runs again on the server
// (supplier-checks check_bill). Needs supabase-client.js (openSupplierEmail, money, escapeHtml,
// poLineCounts, poLinePlace, poQty, isPricingRole).

function billStatusChip(b) {
  if (b.kind === 'credit_note') {
    // a credit note is approved on save: it nets off the supplier's next bills, or Refunded records the money coming back
    if (b.paid) return `<span class="badge accepted">${b.paid_method === 'refund' ? 'Refunded' : 'Settled'}</span>`;
    if (b.check_status === 'problems') return '<span class="badge draft" style="color:var(--red);">Credit, check it</span>';
    return '<span class="badge sent">Credit, nets off the next bill</span>';
  }
  if (b.paid) return '<span class="badge accepted">Paid</span>';
  if (b.approved_for_payment) return `<span class="badge sent">Approved${b.pay_on ? ', pay ' + escapeHtml(poShortDay(b.pay_on)) : ''}</span>`;
  if (b.check_status === 'queried') return '<span class="badge draft" style="color:var(--red);">Queried with supplier</span>';
  if (b.check_status === 'problems') return '<span class="badge draft" style="color:var(--red);">Needs a decision</span>';
  if (b.check_status === 'resolved') return '<span class="badge draft">Accepted, approved at close</span>';
  return '<span class="badge draft">Approved at close</span>';
}
// A bill line that charges nothing (0 supplied on this invoice, or $0). Same rule as isNoCharge() in bill-check.js.
function isNoCharge(l) { return !(Number(l.quantity) > 0) || !(Number(l.unit_cost) > 0); }

function billLineState(l, bill) {
  if (bill && bill.kind === 'credit_note') {
    if (l.goods_returned === true) return { red: false, label: 'Returned' + (l.po_line_item_id ? '' : ', line off the PO') };
    if (l.goods_returned === false) return { red: false, label: l.resolution_note ? 'Money only: ' + l.resolution_note : 'Price credit, goods kept' };
    return { red: false, label: 'Money only' };
  }
  if (l.resolution === 'denied') return { red: true, label: 'Denied' + (l.resolution_note ? ': ' + l.resolution_note : '') };
  if (l.resolution === 'added') return { red: false, label: 'Added to PO' };
  if (l.resolution === 'accepted') return { red: false, label: 'Accepted' + (l.resolution_note ? ': ' + l.resolution_note : '') };
  if (isNoCharge(l)) return { red: false, label: 'No charge' };
  if (l.flag_reason) return { red: true, label: l.flag_reason };
  if (l.po_line_item_id) return { red: false, label: 'On the PO' };
  return { red: true, label: 'Not on the PO' };
}
function renderPoBills(bills, po, role) {
  if (!bills || !bills.length) return '';
  const canDecide = isPricingRole(role);
  const needsWord = (b) => b.kind !== 'credit_note' && (b.supplier_bill_line_items || []).some(l => billLineState(l, b).red);
  const net = bills.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const hasCredit = bills.some(b => b.kind === 'credit_note');
  return `<div style="margin-top:10px; border-top:1px solid var(--border); padding-top:8px;">
    <div class="subtitle" style="font-size:12px; margin-bottom:4px;">Bills on this PO${hasCredit ? ` &middot; net ${money(net)} after credits` : ''}</div>
    ${bills.map(b => `
      <div class="po-bill" data-bill-id="${b.id}" style="margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; font-size:13px;">
          <span><strong>${b.kind === 'credit_note' ? 'Credit' : 'Bill'} ${escapeHtml(b.bill_number || '(no number)')}</strong>${b.bill_date ? ' &middot; ' + escapeHtml(poShortDay(b.bill_date)) : ''} &middot; ${b.kind === 'credit_note' ? '<span style="color:var(--green);">' + money(b.amount) + '</span>' : money(b.amount)}</span>
          <span style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">${billStatusChip(b)}
            ${b.file_path ? `<button type="button" class="secondary btn-sm po-bill-file-btn" data-path="${escapeHtml(b.file_path)}" title="${escapeHtml(b.file_name || '')}">Open ${b.kind === 'credit_note' ? 'credit note' : 'invoice'}</button>` : ''}
            ${(b.dockets || []).map(d => `<button type="button" class="secondary btn-sm po-bill-file-btn" data-path="${escapeHtml(d.file_path)}" title="${escapeHtml(d.file_name || '')}">Open docket</button>`).join('')}
            ${canDecide && !b.paid && needsWord(b) ? `<button type="button" class="secondary btn-sm po-bill-query-btn" data-bill-id="${b.id}">${b.query_sent_at ? 'Email supplier again' : 'Query supplier'}</button>` : ''}
            ${canDecide && !b.paid && b.kind !== 'credit_note' ? `<button type="button" class="secondary btn-sm po-bill-move-btn" data-bill-id="${b.id}" title="This bill is for another PO">Move</button>` : ''}
            ${canDecide && !b.paid ? `<button type="button" class="secondary btn-sm po-bill-remove-btn" data-bill-id="${b.id}" title="Not ours, paid by the customer, entered twice: take it out of TEops" style="color:var(--red);">Remove</button>` : ''}
          </span>
        </div>
        ${b.kind === 'credit_note' && (b.check_issues || []).some(i => i.kind === 'credit_exceeds') ? `<div style="font-size:12px; color:var(--red); margin:3px 0 0 8px;">${escapeHtml((b.check_issues || []).find(i => i.kind === 'credit_exceeds').text)}</div>` : ''}
        ${(b.supplier_bill_line_items || []).map(l => {
          const st = billLineState(l, b);
          const colour = st.red ? 'var(--red)' : 'var(--green)';
          return `<div style="display:flex; justify-content:space-between; gap:6px; flex-wrap:wrap; align-items:center; font-size:12px; padding:3px 0 3px 8px; border-left:3px solid ${colour}; margin-top:3px;">
            <span>${escapeHtml(l.description)} &middot; ${poQty(Math.abs(Number(l.quantity) || 0))} &times; ${money(l.unit_cost)} <span style="color:${colour};">${escapeHtml(st.label)}</span></span>
            ${canDecide && !b.paid && b.kind !== 'credit_note' ? `<span style="display:flex; gap:4px; flex-wrap:wrap;">
              ${st.red && l.resolution !== 'denied' ? `<button type="button" class="secondary btn-sm po-bill-line-btn" data-line-id="${l.id}" data-action="accept" data-desc="${escapeHtml(l.description)}" data-on-po="${l.po_line_item_id ? '1' : ''}">Accept</button>
                <button type="button" class="secondary btn-sm po-bill-line-btn" data-line-id="${l.id}" data-action="deny" data-desc="${escapeHtml(l.description)}" style="color:var(--red);">Deny charge</button>` : ''}
              ${l.resolution === 'accepted' || l.resolution === 'denied' ? `<button type="button" class="secondary btn-sm po-bill-line-btn" data-line-id="${l.id}" data-action="undo" data-desc="${escapeHtml(l.description)}">Undo</button>` : ''}
            </span>` : ''}
          </div>`;
        }).join('')}
      </div>`).join('')}
  </div>`;
}
// Re-check a bill against its PO after a decision (issues and approval are kept by the server).
async function recheckBill(billId) {
  try { await supplierChecksCall({ action: 'check_bill', id: billId }); }
  catch (err) { console.error('bill check did not run:', err.message); }
}
// The please-explain email to the supplier: written by the server (denied charges first, then
// anything else that does not line up), edited here, sent only on Send. Resolves when closed.
function openSupplierQueryEmail(billId) {
  return openSupplierEmail({ kind: 'bill_query', id: billId, intro: 'Sent from invoice@thomsonenergy.com.au. The bill stays unapproved until it is sorted; their reply shows on Bill checks.' });
}
function wirePoBillButtons(containerEl, onComplete, bills) {
  containerEl.querySelectorAll('.po-bill-line-btn').forEach(btn => btn.addEventListener('click', async () => {
    const { lineId, action, desc, onPo } = btn.dataset;
    let note = null;
    if (action === 'accept') {
      const freight = /(freight|delivery|deliver|shipping|postage|courier|handling|cartage)/i.test(desc);
      if (!confirm(onPo ? `Accept the higher price for "${desc}"? The PO line and the job's cost take the billed price.`
        : `Accept "${desc}"? It is added to the PO${freight ? ' and costed straight away' : ' and received the normal way'}.`)) return;
    } else if (action === 'deny') {
      note = prompt(`Deny "${desc}". Why? (goes in the email to the supplier)`, '');
      if (note === null) return;
    }
    btn.disabled = true;
    const { error } = await supabaseClient.rpc('supplier_bill_line_resolve', { p_line_id: lineId, p_action: action, p_note: note });
    if (error) { alert(friendlyError(error)); btn.disabled = false; return; }
    const billId = btn.closest('.po-bill')?.dataset.billId;
    if (billId) await recheckBill(billId);
    if (action === 'deny' && billId) await openSupplierQueryEmail(billId);
    if (onComplete) await onComplete();
  }));
  containerEl.querySelectorAll('.po-bill-query-btn').forEach(btn => btn.addEventListener('click', async () => {
    await openSupplierQueryEmail(btn.dataset.billId);
    if (onComplete) await onComplete();
  }));
  // the supplier's invoice (and any packing slip filed with it), one tap from the bill (item 83)
  containerEl.querySelectorAll('.po-bill-file-btn').forEach(btn => btn.addEventListener('click', async () => {
    try { await openSignedDocInNewTab(btn.dataset.path); } catch (err) { alert(friendlyError(err)); }
  }));
  // a bill on the wrong PO (js/supplier-bill-actions.js, item 83 part B): the page passes the bills through bills
  const billById = (id) => (bills || []).find(b => b.id === id) || { id };
  containerEl.querySelectorAll('.po-bill-move-btn').forEach(btn => btn.addEventListener('click', () => {
    if (typeof openMoveBillPanel !== 'function') { alert('Move is not loaded on this page.'); return; }
    openMoveBillPanel(billById(btn.dataset.billId), { onDone: onComplete });
  }));
  containerEl.querySelectorAll('.po-bill-remove-btn').forEach(btn => btn.addEventListener('click', () => {
    if (typeof removeBill !== 'function') { alert('Remove is not loaded on this page.'); return; }
    removeBill(billById(btn.dataset.billId), onComplete);
  }));
}
// The one thing to do next on a PO, in this order: decide on a bill line in red, close an
// all-received PO, add lines (or the invoice on an open PO), email it, receive what arrived.
function poNextStep(po, bills, { emailed, role } = {}) {
  const c = poLineCounts(po);
  if (po.closed_at) return { key: 'closed', label: 'Closed and approved for payment', hint: 'Nothing more to do. Admin or Finance can reopen it under More.', done: true };
  const redLine = isPricingRole(role) && (bills || []).some(b => !b.paid && b.kind !== 'credit_note' && (b.supplier_bill_line_items || []).some(l => l.resolution !== 'denied' && billLineState(l, b).red));
  if (redLine) return { key: 'bills', label: 'Decide on the bill lines in red', hint: 'A bill does not match this PO. Accept each red line, or deny the charge and the supplier is asked about it.' };
  if (po.status === 'received' && c.total) return { key: 'close', label: 'All received: close and approve', hint: 'Closing approves its bills for payment.' };
  if (!c.total) {
    // Reading the invoice is for pricing roles only (bug F9); anyone else adds the lines by hand.
    if (po.po_type === 'open' && po.supplier_id && isPricingRole(role)) return { key: 'invoice', label: "Upload the supplier's invoice", hint: 'An open PO takes its lines from the invoice.' };
    if (po.po_type === 'open' && po.supplier_id) return { key: 'add', label: 'Add the lines', hint: "What arrived, how many, and the unit cost. Admin, Finance or Sales can upload the supplier's invoice instead." };
    return { key: 'add', label: 'Add the lines', hint: 'What is being ordered, how many, and the unit cost.' };
  }
  if (po.supplier_id && !po.stock_source && !emailed && !c.received) return { key: 'email', label: 'Email the PO to the supplier', hint: 'Then tick each line below as it arrives.' };
  if (c.toReceive) return { key: 'receive', label: 'Receive what arrived', hint: 'Tick the lines that came in, then press Receive.' };
  if (c.backordered) return { key: 'close', label: `Waiting on ${c.backordered} back ordered line${c.backordered === 1 ? '' : 's'}`, hint: 'Wait for it, or close now and it is cancelled off the PO.', secondary: true };
  return { key: 'close', label: 'Close PO' };
}

// ---------- Delete a PO line that no bill charges for (item 88, migration 20261204000000) ----------
// A line typed in by hand that the supplier's bill did not match, or one added by mistake. The
// database does it in one step (po_line_delete): a received line comes back off the job's costs,
// the stock count or the Tools register first, then the line goes. It refuses a line a bill or
// credit note charges for, goods already invoiced to the client, and a closed PO.

// The PO lines a bill or credit note on this PO points at.
function poLinesOnBills(bills) {
  const ids = new Set();
  (bills || []).forEach(b => (b.supplier_bill_line_items || []).forEach(l => { if (l.po_line_item_id) ids.add(l.po_line_item_id); }));
  return ids;
}
function canDeletePoLine(li, po, bills, role) {
  return isPricingRole(role) && !po.closed_at && !poLinesOnBills(bills).has(li.id);
}
// What deleting this line does, said before it happens.
function poLineDeleteEffect(li, po) {
  const amount = money(Number(li.quantity) * Number(li.unit_cost));
  if (!li.received) return `The PO total drops by ${amount}.`;
  if (li.destination_type === 'job') return `It is received to ${poLinePlace(li)}, so ${amount} comes off that job's costs${po.stock_source ? ' and the stock goes back where it was pulled from' : ''}.`;
  if (li.destination_type === 'tools') return 'It is received to the Tools register, so it comes out of there.';
  return `It is received to ${poLinePlace(li)}, so ${poQty(li.quantity)} comes off that stock count.`;
}
async function deletePoLine(li, po, bills, onComplete) {
  if (!confirm(`Delete "${li.description}" (${poQty(li.quantity)} x ${money(li.unit_cost)}) from ${po.po_number || 'this PO'}? ${poLineDeleteEffect(li, po)}`)) return;
  const { error } = await supabaseClient.rpc('po_line_delete', { p_line_id: li.id });
  // refused (a bill landed on it, someone else got there first): say why and show the PO as it is now
  if (error) { alert(friendlyError(error)); if (onComplete) await onComplete(); return; }
  // the PO's total changed, so its unpaid bills are checked against it again
  await Promise.all((bills || []).filter(b => !b.paid).map(b => recheckBill(b.id)));
  showToast(`${li.description} deleted from ${po.po_number || 'the PO'}`);
  if (onComplete) await onComplete();
}
// The line's "..." menu on the PO page: Delete, when no bill charges for the line.
function poLineDeleteMenu(li, po, bills, role, onComplete) {
  if (!canDeletePoLine(li, po, bills, role)) return [];
  return [{ label: 'Delete this line', hint: li.received ? 'Takes it back off where it was received, then off the PO' : 'Not ordered after all, or typed in by mistake', danger: true, onPick: () => deletePoLine(li, po, bills, onComplete) }];
}
// Once the PO has a bill, every line the bill does not charge for is marked on the row, with
// Delete beside it (the line typed in by hand that the bill came in under another name). A bill
// saved with no lines read cannot say what it charges for, so nothing is marked while one is there.
function markPoLinesNotOnBill(containerEl, po, bills, role, onComplete) {
  const charged = (bills || []).filter(b => b.kind !== 'credit_note');
  if (!charged.length || charged.some(b => !(b.supplier_bill_line_items || []).length)) return;
  (po.purchase_order_line_items || []).filter(li => canDeletePoLine(li, po, bills, role)).forEach(li => {
    const row = [...containerEl.querySelectorAll('.po-line')].find(r => r.dataset.lineId === li.id);
    if (!row) return;
    row.querySelector('.po-line-desc').insertAdjacentHTML('beforeend', ' <span class="badge draft" title="No bill on this PO charges for this line">Not on a bill</span>');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary btn-sm po-line-delete';
    btn.style.cssText = 'color:var(--red); flex-shrink:0;';
    btn.textContent = 'Delete';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await deletePoLine(li, po, bills, onComplete); } finally { btn.disabled = false; }
    });
    row.insertBefore(btn, row.querySelector('.po-line-more'));
  });
}
