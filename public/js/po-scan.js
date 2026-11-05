// Paid on the spot and the scanned invoice on a Create PO panel (backlog item 51). Loaded on demand
// (loadPoScan in supabase-client.js): every Create PO panel awaits it before drawing, the PO page and the
// supplier page load it when a paid button is pressed. Any role.
//
// poPaidChoiceHtml / wirePoPaidChoice / setPoPaidChoice / readPoPaidChoice: the "Paid already" tick on a panel.
// poScanButtonHtml + wirePoScan(overlay, { prefix, containerId, materials, picker })
//   The button picks a photo or PDF, Tally reads it (extract-supplier-invoice), and the panel is filled
//   in: the supplier (matched by account number, ABN, bank details or name; otherwise typed in as new),
//   the lines (quantity supplied, unit cost, part number, the Stock item by part number or exact name),
//   Lines known now, and Paid already when the document says it is paid. The reading and the file stay
//   on overlay._poScan for the save.
// poScanSave(overlay, { prefix, supplierId, po, lines }) -> { po, bill_id, bill_paid }
//   One server step (po-from-scan): the receipt saved as the bill and the PO made from it, lines linked,
//   the bill paid when the PO is. po: the panel's fields for new_po; lines: readMaterialLineRows().

function wirePoScan(overlay, opts) {
  const btn = overlay.querySelector(`#${opts.prefix}-scan-btn`);
  if (!btn) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.jpg,.jpeg,.png,.heic,image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (file) await poScanRead(overlay, opts, file);
  };
  btn.addEventListener('click', () => input.click());
}

async function poScanRead(overlay, opts, file) {
  const note = overlay.querySelector(`#${opts.prefix}-scan-note`);
  const btn = overlay.querySelector(`#${opts.prefix}-scan-btn`);
  note.textContent = 'Reading it...';
  btn.disabled = true;
  try {
    const fileBase64 = await fileToBase64(file);
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/extract-supplier-invoice', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ fileBase64, mediaType: file.type || 'application/pdf' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not read that file. Try a clearer photo.');
    const ex = data.extracted || {};
    if (ex.document_type && ex.document_type !== 'invoice') throw new Error(`That looks like a ${ex.document_type === 'statement' ? 'statement' : ex.document_type === 'credit_note' ? 'credit note' : 'document that is not an invoice'}, not an invoice or receipt.`);

    // the supplier: a confident match is picked; a shared account number or no match leaves the name typed in
    let supplierNote = '';
    if (ex.supplier) {
      const found = await findMatchingSupplier({ name: ex.supplier, ourAccountNumber: ex.our_account_number, abn: ex.abn, bsb: ex.bsb, bankAccountNumber: ex.bank_account_number });
      if (found?.supplier && !found.shared) { opts.picker.select(found.supplier.id, found.supplier.name); supplierNote = found.supplier.name; }
      else { opts.picker.typeNew(ex.supplier); supplierNote = `${ex.supplier} (new supplier, check the name)`; }
    }

    // the lines: what was supplied on this document, at the price charged; 0 supplied is left out (item 50)
    const container = document.getElementById(opts.containerId);
    container.innerHTML = '';
    const lines = (ex.line_items || []).filter(l => l.description);
    let added = 0;
    for (const l of lines) {
      const quantity = l.quantity == null || l.quantity === '' ? 1 : (Number(l.quantity) || 0);
      if (!(quantity > 0)) continue;
      const partNumber = String(l.part_number || '').trim() || null;
      let materialId = null;
      if (partNumber) {
        const { data } = await supabaseClient.rpc('_material_by_code', { p_barcode: partNumber, p_part_number: partNumber });
        materialId = data || null;
      }
      if (!materialId) {
        const m = (opts.materials || []).find(x => String(x.name || '').trim().toLowerCase() === String(l.description).trim().toLowerCase());
        if (m) materialId = m.id;
      }
      const row = buildMaterialSearchRow(opts.materials || [], opts.containerId);
      row._fill({ description: l.description, quantity, unit_cost: Number(l.unit_cost) || 0, materialId, partNumber });
      added += 1;
    }
    if (!added) buildMaterialSearchRow(opts.materials || [], opts.containerId);

    // the invoice is the order: a fixed PO
    const fixed = overlay.querySelector(`input[name="${opts.prefix}-po-type"][value="fixed"]`);
    if (fixed) fixed.checked = true;
    if (ex.paid_status === 'paid') setPoPaidChoice(overlay, opts.prefix, ['card', 'cash', 'bank_transfer', 'other'].includes(ex.payment_method) ? ex.payment_method : 'card', ex.bill_number ? `Receipt ${ex.bill_number}` : '');

    overlay._poScan = { extracted: ex, file, fileName: file.name };
    note.innerHTML = `Read ${added} line${added === 1 ? '' : 's'}${supplierNote ? ' from ' + escapeHtml(supplierNote) : ''}${ex.bill_number ? ', invoice ' + escapeHtml(ex.bill_number) : ''}${ex.total ? ', total ' + escapeHtml(money(ex.total)) : ''}${ex.paid_status === 'paid' ? ', <strong>marked paid</strong>' : ''}. Check it, then press Create PO.`;
  } catch (err) {
    note.innerHTML = `<span style="color:var(--red);">${escapeHtml(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function poScanSave(overlay, { prefix, supplierId, po, lines }) {
  const scan = overlay._poScan;
  if (!scan) throw new Error('Scan the invoice first.');
  if (!supplierId) throw new Error('Pick or type the supplier first.');
  if (!lines.length) throw new Error('Add at least one line.');
  const paid = readPoPaidChoice(overlay, prefix);
  const ex = scan.extracted;
  const linesTotal = lines.reduce((t, l) => t + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0);
  // the original photo or PDF is kept with the bill, same as the supplier page's review screen
  const filePath = await uploadPrivateFile(scan.file, `bills/${supplierId}`);
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/po-from-scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ p: {
      supplier_id: supplierId,
      bill_number: ex.bill_number || null,
      bill_date: ex.bill_date || null,
      amount: Number(ex.total) || Math.round(linesTotal * 1.1 * 100) / 100,
      po_mode: 'new', po_id: null,
      new_po: { ...po, paid_method: paid.paid_method, paid_reference: paid.paid_reference, paid_on: paid.paid_on },
      file_path: filePath, file_name: scan.fileName,
      lines: lines.map(l => ({ description: l.description, quantity: l.quantity, unit_cost: l.unit_cost, part_number: l.part_number || null, material_id: l.materialId || null, create_material: false, replace_po_line_id: null })),
    } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save the PO.');
  return data;
}

// ---------- moved out of supabase-client.js (page weight): the paid tick, the scan button, the paid panels ----------
// Paid on the spot (item 51): card at the counter, cash, a transfer made upfront. Whoever bought it says so,
// any role; every bill saved against the PO is then marked paid with these details (po_set_paid, the save).
const PO_PAID_METHODS = [['card', 'Card'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['other', 'Other']];
function poPaidChoiceHtml(prefix) {
  return `<label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:10px;"><input type="checkbox" id="${prefix}-paid" style="width:auto;" /> Paid already (card at the counter, cash)</label>
    <div id="${prefix}-paid-fields" style="display:none; margin:4px 0 0 24px;">
      <div class="grid cols-2">
        <div><label style="margin-top:0; font-size:12px;">How</label><select id="${prefix}-paid-method">${PO_PAID_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div><label style="margin-top:0; font-size:12px;">Reference (optional)</label><input id="${prefix}-paid-reference" placeholder="Receipt or card reference" /></div>
      </div>
      <p class="subtitle" style="font-size:12px; margin:4px 0 0;">The supplier's invoice or receipt for this PO is marked paid when it is saved, so it never waits in Pay bills due.</p>
    </div>`;
}
function wirePoPaidChoice(root, prefix) {
  const cb = root.querySelector(`#${prefix}-paid`);
  if (!cb) return;
  cb.addEventListener('change', () => { root.querySelector(`#${prefix}-paid-fields`).style.display = cb.checked ? 'block' : 'none'; });
}
function setPoPaidChoice(root, prefix, method, reference) {
  const cb = root.querySelector(`#${prefix}-paid`);
  if (!cb) return;
  cb.checked = true;
  root.querySelector(`#${prefix}-paid-fields`).style.display = 'block';
  const sel = root.querySelector(`#${prefix}-paid-method`);
  if ([...sel.options].some(o => o.value === method)) sel.value = method;
  if (reference) root.querySelector(`#${prefix}-paid-reference`).value = reference;
}
// The PO columns for an insert (paid_on today, paid_by the person), or nulls when not ticked.
function readPoPaidChoice(root, prefix, userId) {
  const cb = root.querySelector(`#${prefix}-paid`);
  if (!cb || !cb.checked) return { paid_method: null, paid_on: null, paid_reference: null, paid_by: null };
  return {
    paid_method: root.querySelector(`#${prefix}-paid-method`).value,
    paid_on: sydneyDateKey(new Date()),
    paid_reference: root.querySelector(`#${prefix}-paid-reference`).value.trim() || null,
    paid_by: userId || null,
  };
}

// "Scan the invoice or receipt" on a Create PO panel (item 51): the reading fills the panel; js/po-scan.js
// is loaded when the button is first pressed. opts: see wirePoScan there.
function poScanButtonHtml(prefix) {
  return `<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 10px;">
    <button type="button" class="secondary btn-sm" id="${prefix}-scan-btn">&#128247; Scan the invoice or receipt</button>
    <span class="subtitle" id="${prefix}-scan-note" style="font-size:12px;">Fills in the supplier and the lines; the bill is saved with the PO.</span>
  </div>`;
}

// Mark a PO paid (or not paid after all) from its page: More menu, any role.
function openPoPaidPanel(po, onComplete) {
  const overlay = openModal(`
    <h2>PO ${escapeHtml(po.po_number || '')} paid already</h2>
    <p class="subtitle" style="margin-bottom:10px;">Card at the counter, cash, or a transfer made upfront. Its bills are marked paid with these details, now and when they arrive.</p>
    <div class="grid cols-2">
      <div><label style="margin-top:0;">How</label><select id="pp-method">${PO_PAID_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div><label style="margin-top:0;">Paid on</label><input id="pp-on" type="date" value="${sydneyDateKey(new Date())}" /></div>
    </div>
    <label>Reference (optional)</label>
    <input id="pp-ref" placeholder="Receipt or card reference" />
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="pp-save">Mark paid</button><button type="button" class="secondary" id="pp-cancel">Cancel</button></div>
    <div id="pp-msg"></div>`, { maxWidth: 420 });
  overlay.querySelector('#pp-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#pp-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#pp-save');
    btn.disabled = true;
    const { error } = await supabaseClient.rpc('po_set_paid', { p_po_id: po.id, p_method: overlay.querySelector('#pp-method').value, p_paid_on: overlay.querySelector('#pp-on').value || null, p_reference: overlay.querySelector('#pp-ref').value.trim() || null });
    if (error) { overlay.querySelector('#pp-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; btn.disabled = false; return; }
    overlay.remove();
    if (onComplete) await onComplete();
  });
}

// Paid any time (item 51): Admin and Finance mark a bill paid whether or not it is approved yet (paid upfront,
// card at the counter). Supplier page and Bill checks. One server step: approved by the person pressing the
// button and marked paid with the date, how and a reference (run-supplier-payments mark_paid_any).
function openBillPaidPanel(bill, onComplete) {
  const methods = [...PO_PAID_METHODS.slice(0, 3), ['airwallex', 'Airwallex'], ['other', 'Other']];
  const overlay = openModal(`
    <h2>Bill ${escapeHtml(bill.bill_number || '(no number)')} paid</h2>
    <p class="subtitle" style="margin-bottom:10px;">${money(bill.amount)}${bill.approved_for_payment ? '' : '. Not approved yet: this approves it too, by you, as paid upfront.'}</p>
    <div class="grid cols-2">
      <div><label style="margin-top:0;">How</label><select id="bp-method">${methods.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div><label style="margin-top:0;">Paid on</label><input id="bp-on" type="date" value="${sydneyDateKey(new Date())}" /></div>
    </div>
    <label>Reference (optional)</label>
    <input id="bp-ref" placeholder="Card, Airwallex or bank reference" />
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="bp-save">Record as paid</button><button type="button" class="secondary" id="bp-cancel">Cancel</button></div>
    <div id="bp-msg"></div>`, { maxWidth: 420 });
  overlay.querySelector('#bp-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#bp-save');
    btn.disabled = true;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/run-supplier-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'mark_paid_any', bill_id: bill.id, paid_on: overlay.querySelector('#bp-on').value, method: overlay.querySelector('#bp-method').value, reference: overlay.querySelector('#bp-ref').value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
      overlay.remove();
      if (onComplete) await onComplete();
    } catch (err) {
      overlay.querySelector('#bp-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false;
    }
  });
}
