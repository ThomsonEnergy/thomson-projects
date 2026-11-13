// Move to another PO, Remove bill and Refunded on a supplier bill or credit note (items 82 and 83 part B).
// Loaded by purchase-order.html and supplier-detail.html; the PO page's Bills fold (renderPoBills in
// supabase-client.js) and the supplier page's bills table call these from their buttons.
//
//   openMoveBillPanel(bill, { supplierId, onDone })  pick one of the supplier's open POs (or No PO) and a note:
//                                                    supplier-bill-move 'move' (supplier_bill_relocate)
//   removeBill(bill, onDone)                         a reason, then supplier-bill-move 'remove' (supplier_bill_remove)
//   refundCreditNote(bill, onDone)                   the credit's money came back: run-supplier-payments 'mark_paid_any'
//                                                    with method 'refund' (Admin and Finance)
// Writes nothing itself; every change is one database step on the server.

async function supplierBillMoveCall(body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/supplier-bill-move', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}

function billWord(bill) { return bill.kind === 'credit_note' ? 'Credit note' : 'Bill'; }

async function openMoveBillPanel(bill, { supplierId, onDone } = {}) {
  const sid = supplierId || bill.supplier_id;
  const overlay = openModal(`<p class="subtitle">Loading the supplier's POs...</p>`, { maxWidth: 480 });
  const { data: pos, error } = await supabaseClient.from('purchase_orders')
    .select('id, po_number, description, status, closed_at, project_id, projects(name, job_number, quote_number)')
    .eq('supplier_id', sid).is('closed_at', null).order('created_at', { ascending: false });
  if (error) { overlay.querySelector('.card').innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div><button type="button" class="secondary" id="mb-x">Close</button>`; overlay.querySelector('#mb-x').addEventListener('click', () => overlay.remove()); return; }
  const others = (pos || []).filter(po => po.id !== bill.po_id);
  const label = (po) => `${po.po_number || 'PO'} - ${po.projects ? projectRef(po.projects) : 'Stock'}${po.description ? ' - ' + po.description : ''}`;
  overlay.querySelector('.card').innerHTML = `
    <h2>Move ${billWord(bill).toLowerCase()} ${escapeHtml(bill.bill_number || '(no number)')}</h2>
    <p class="subtitle" style="margin-bottom:10px;">Its lines come off the PO it is on now (anything Accept added, received goods back out of stock or off the job) and are matched against the PO you pick. The bill is approved again when that PO closes.</p>
    <label style="margin-top:0;">To</label>
    <select id="mb-po">
      <option value="">Pick the PO...</option>
      ${others.map(po => `<option value="${escapeHtml(po.id)}">${escapeHtml(label(po))}</option>`).join('')}
      <option value="__none__">No PO (a bill on the account)</option>
    </select>
    <label>Why (goes in the log)</label>
    <input id="mb-note" placeholder="e.g. the invoice was for the other job" />
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="mb-save">Move</button><button type="button" class="secondary" id="mb-cancel">Cancel</button></div>
    <div id="mb-msg"></div>`;
  overlay.querySelector('#mb-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#mb-save').addEventListener('click', async () => {
    const pick = overlay.querySelector('#mb-po').value;
    const msg = overlay.querySelector('#mb-msg');
    if (!pick) { msg.innerHTML = '<div class="error-box">Pick the PO it is for, or No PO.</div>'; return; }
    const btn = overlay.querySelector('#mb-save');
    btn.disabled = true; btn.textContent = 'Moving...';
    try {
      await supplierBillMoveCall({ action: 'move', bill_id: bill.id, po_id: pick === '__none__' ? null : pick, note: overlay.querySelector('#mb-note').value.trim() });
      showToast(`${billWord(bill)} ${bill.bill_number || ''} moved`);
      overlay.remove();
      if (onDone) await onDone();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false; btn.textContent = 'Move';
    }
  });
}

async function removeBill(bill, onDone) {
  const reason = prompt(`Remove ${billWord(bill).toLowerCase()} ${bill.bill_number || ''} from TEops? Say why (paid by the customer, not ours, entered twice...). Anything Accept added to the PO comes off it; its emailed card is put aside with this reason.`, '');
  if (reason === null) return;
  if (!reason.trim()) { alert('Say why it is being removed.'); return; }
  try {
    await supplierBillMoveCall({ action: 'remove', bill_id: bill.id, reason: reason.trim() });
    showToast(`${billWord(bill)} ${bill.bill_number || ''} removed`);
    if (onDone) await onDone();
  } catch (err) { alert(friendlyError(err)); }
}

function refundCreditNote(bill, onDone) {
  const overlay = openModal(`
    <h2>Credit note ${escapeHtml(bill.bill_number || '(no number)')} refunded</h2>
    <p class="subtitle" style="margin-bottom:10px;">${money(Math.abs(Number(bill.amount) || 0))} came back to us (card, bank) instead of coming off the next bill.</p>
    <label style="margin-top:0;">Refunded on</label><input id="rf-on" type="date" value="${sydneyDateKey(new Date())}" />
    <label>Reference (optional)</label><input id="rf-ref" placeholder="Bank or card reference" />
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="rf-save">Record as refunded</button><button type="button" class="secondary" id="rf-cancel">Cancel</button></div>
    <div id="rf-msg"></div>`, { maxWidth: 420 });
  overlay.querySelector('#rf-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rf-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#rf-save');
    btn.disabled = true;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/run-supplier-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'mark_paid_any', bill_id: bill.id, paid_on: overlay.querySelector('#rf-on').value, method: 'refund', reference: overlay.querySelector('#rf-ref').value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
      overlay.remove();
      if (onDone) await onDone();
    } catch (err) {
      overlay.querySelector('#rf-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false;
    }
  });
}

// The review screen for a credit note uploaded on the supplier page (or Review in full on the Emailed bills
// page): number, date, amount, the PO, each line matched to a PO line with "goods went back" decided by the
// price (switch it if the credit note was a price adjustment). Save runs supplier_credit_note_save.
async function openCreditReviewPanel({ supplierId, supplierName, extracted, sourceFile = null, filePath = null, fileName = null, inboxItemId = null, preselectedPoId = null, onDone = null }) {
  const ex = extracted || {};
  const overlay = openModal(`<p class="subtitle">Loading the supplier's POs...</p>`, { maxWidth: 720 });
  const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const { data: pos } = await supabaseClient.from('purchase_orders')
    .select('id, po_number, description, closed_at, projects(name, job_number, quote_number), purchase_order_line_items(id, material_id, description, quantity, unit_cost)')
    .eq('supplier_id', supplierId).or(`closed_at.is.null,closed_at.gte.${since}`).order('created_at', { ascending: false });
  const poList = pos || [];
  const label = (po) => `${po.po_number || 'PO'} - ${po.projects ? projectRef(po.projects) : 'Stock'}${po.description ? ' - ' + po.description : ''}${po.closed_at ? ' (closed)' : ''}`;
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const score = (a, b) => { const A = new Set(norm(a)), B = norm(b); if (!A.size || !B.length) return 0; return B.filter(w => A.has(w)).length / Math.max(A.size, B.length); };
  const partNorm = (p) => String(p || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const lines = (ex.line_items || []).filter(l => l.description).map(l => ({ description: l.description, part_number: l.part_number || null, quantity: Math.abs(Number(l.quantity) || 1), unit_cost: Math.abs(Number(l.unit_cost) || 0), unit: l.unit || null }));

  // which PO line each credited line is for, on the PO picked: the part number in the line's words, else the description
  const planFor = (poId) => {
    const po = poList.find(p => p.id === poId);
    const poLines = po ? (po.purchase_order_line_items || []) : [];
    return lines.map(l => {
      const part = partNorm(l.part_number);
      let hit = part ? poLines.find(pl => String(pl.description || '').split(/\s+/).some(w => partNorm(w) === part)) : null;
      if (!hit) { let best = null, bs = 0; poLines.forEach(pl => { const sc = score(pl.description, l.description); if (sc > bs) { bs = sc; best = pl; } }); if (bs >= 0.6) hit = best; }
      const same = hit ? Math.abs(l.unit_cost - Number(hit.unit_cost)) <= Math.max(0.01, Number(hit.unit_cost) * 0.01) : false;
      return { ...l, po_line_item_id: hit?.id || null, material_id: hit?.material_id || null, po_line: hit, goods_returned: hit ? same : null };
    });
  };
  const render = () => {
    const poId = overlay.querySelector('#cr-po') ? overlay.querySelector('#cr-po').value : (preselectedPoId || '');
    const plan = planFor(poId);
    overlay.querySelector('#cr-lines').innerHTML = plan.map((l, i) => `
      <div class="cr-line" data-i="${i}" style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; font-size:13px; padding:6px 0; border-top:1px solid var(--border);">
        <span>${escapeHtml(l.description)} &middot; ${l.quantity} &times; ${money(l.unit_cost)}${l.po_line ? ` <span class="subtitle" style="font-size:12px;">on the PO as "${escapeHtml(l.po_line.description)}" at ${money(l.po_line.unit_cost)}</span>` : ' <span class="subtitle" style="font-size:12px;">not on this PO: money only</span>'}</span>
        ${l.po_line ? `<label style="display:flex; align-items:center; gap:6px; font-weight:400; margin:0; font-size:12px;"><input type="checkbox" class="cr-returned" ${l.goods_returned ? 'checked' : ''} style="width:auto;" /> goods went back${l.goods_returned ? '' : ' (a price credit as it stands)'}</label>` : ''}
      </div>`).join('') || '<p class="subtitle">No lines were read: the credit is saved as money only.</p>';
    overlay.querySelectorAll('.cr-returned').forEach(cb => cb.addEventListener('change', () => { plan[Number(cb.closest('.cr-line').dataset.i)].goods_returned = cb.checked; }));
    overlay._plan = plan;
  };
  overlay.querySelector('.card').innerHTML = `
    <h2>Credit note from ${escapeHtml(supplierName || 'the supplier')}</h2>
    <p class="subtitle" style="margin-bottom:10px;">A credit note is a bill with a minus in front: it nets off this supplier's next bills. Goods that went back come off the PO (and out of Stock or off the job if they were received); a price credit drops the PO line's price instead.</p>
    <div class="grid cols-3">
      <div><label style="margin-top:0;">Credit number</label><input id="cr-num" value="${escapeHtml(ex.bill_number || '')}" /></div>
      <div><label style="margin-top:0;">Date</label><input id="cr-date" type="date" value="${escapeHtml(ex.bill_date || '')}" /></div>
      <div><label style="margin-top:0;">Amount inc GST</label><input id="cr-amount" type="number" step="0.01" value="${escapeHtml(ex.total != null ? Math.abs(Number(ex.total)) : '')}" /></div>
    </div>
    <label>Against PO</label>
    <select id="cr-po"><option value="">No PO: a credit on the account</option>${poList.map(po => `<option value="${escapeHtml(po.id)}" ${po.id === preselectedPoId ? 'selected' : ''}>${escapeHtml(label(po))}</option>`).join('')}</select>
    <label style="margin-top:12px;">Lines</label>
    <div id="cr-lines"></div>
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="cr-save">Save credit note</button><button type="button" class="secondary" id="cr-cancel">Cancel</button></div>
    <div id="cr-msg"></div>`;
  render();
  overlay.querySelector('#cr-po').addEventListener('change', render);
  overlay.querySelector('#cr-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#cr-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#cr-save'), msg = overlay.querySelector('#cr-msg');
    const amount = Math.abs(parseFloat(overlay.querySelector('#cr-amount').value) || 0);
    if (!(amount > 0)) { msg.innerHTML = '<div class="error-box">Enter the credit amount.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      let path = filePath, name = fileName;
      if (sourceFile && !path) { path = await uploadPrivateFile(sourceFile, `bills/${supplierId}`); name = sourceFile.name; }
      const poId = overlay.querySelector('#cr-po').value || null;
      const { data: creditId, error } = await supabaseClient.rpc('supplier_credit_note_save', { p: {
        supplier_id: supplierId, credit_number: overlay.querySelector('#cr-num').value.trim() || null, credit_date: overlay.querySelector('#cr-date').value || null,
        amount, po_id: poId, file_path: path, file_name: name,
        lines: (overlay._plan || []).map(l => ({ description: l.description, part_number: l.part_number, quantity: l.quantity, unit_cost: l.unit_cost, unit: l.unit, material_id: l.material_id, po_line_item_id: poId ? l.po_line_item_id : null, goods_returned: l.goods_returned })),
      } });
      if (error) throw error;
      const { data: { session } } = await supabaseClient.auth.getSession();
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
      await fetch('/.netlify/functions/supplier-checks', { method: 'POST', headers, body: JSON.stringify({ action: 'check_bill', id: creditId }) }).catch(() => {});
      if (inboxItemId) await fetch('/.netlify/functions/supplier-bill-inbox', { method: 'POST', headers, body: JSON.stringify({ action: 'mark_saved', id: inboxItemId, bill_id: creditId }) }).catch(() => {});
      showToast('Credit note saved');
      overlay.remove();
      if (onDone) await onDone();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false; btn.textContent = 'Save credit note';
    }
  });
}
