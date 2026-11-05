// Scan a part into Stock (docs/IDEAS_BACKLOG.md item 44, spec A12). One panel, three callers: the
// Stock page (+ Scan a part), a vehicle page (Scan a part into this van) and the clock-out stock
// panel in supabase-client.js (Take a photo of the label, loaded on demand).
//
// Camera -> compressImage() -> the phone's own barcode reader (BarcodeDetector, where the browser has
// one) and the read-part-label function (Claude reads the barcode digits, part number, brand, a
// name and what kind of thing it is: part, cable with the drum size, consumable with the pack, or a
// tool, item 53) -> a check panel (everything editable, how many, where) -> material_add_from_scan, the one
// database step that makes the item at $0 flagged Needs a price (or adds the count to the item that
// already has that barcode or part number) and sets the count where the person is.
// Writes: materials and the counts through material_add_from_scan only; on Save the photo goes to
// project-documents/stock/labels/ and is kept on the item (materials.photo_path) when it has none.
//
//   openStockScanPanel({ loc, vehicleId, askTook, onDone })
//     loc / vehicleId: the place prefilled ('warehouse' or 'vehicle'); the panel lets it be changed
//     askTook: the clock-out mode: "Took" and "Left there" instead of "How many here"; the count
//              saved is took + left and SET at that place (not added), the stock pull then takes
//              "took" off it; a cable item gets one drum of took + left metres (unit_id comes back)
//     onDone({ material_id, name, existed, needs_price, quantity, took, left, kind, pack_qty, unit_id })

const STOCK_SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

function stockScanPickPhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// The phone's own reader: free and instant where the browser has it (Android Chrome), null elsewhere.
async function stockScanLocalBarcode(file) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const detector = new window.BarcodeDetector({ formats: STOCK_SCAN_FORMATS.filter(f => supported.includes(f)) });
    const bitmap = await createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    const code = codes.find(c => /^\d{8,14}$/.test(c.rawValue)) || codes[0];
    return code ? String(code.rawValue).trim() : null;
  } catch (e) {
    return null;
  }
}

async function stockScanReadLabel(file) {
  const fileBase64 = await fileToBase64(file);
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/read-part-label', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ fileBase64, mediaType: file.type || 'image/jpeg' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Could not read the label (${res.status})`);
  return data.label || {};
}

async function openStockScanPanel({ loc = 'warehouse', vehicleId = null, askTook = false, onDone } = {}) {
  const file = await stockScanPickPhoto();
  if (!file) return;
  const overlay = openModal(`<h2 style="margin-bottom:4px;">Scan a part</h2><p class="subtitle" id="ss-status">Reading the label...</p>`, { maxWidth: 500 });
  const q = (sel) => overlay.querySelector(sel);
  const bigBtn = STOCK_BIG_BTN;

  const small = await compressImage(file, 1600, 0.85).catch(() => file);
  const preview = URL.createObjectURL(small);
  const [vehicles, localCode, read] = await Promise.all([
    stockVehicles().then(async v => { await loadStockKinds(); return v; }),
    stockScanLocalBarcode(small),
    stockScanReadLabel(small).catch(err => ({ error: err.message })),
  ]);
  const label = read.error ? {} : read;
  const barcode = localCode || label.barcode || '';
  const partNumber = label.part_number || '';

  // the item that already has this barcode or part number, so no second one is made
  let existing = null;
  if (barcode || partNumber) {
    const { data: id } = await supabaseClient.rpc('_material_by_code', { p_barcode: barcode || null, p_part_number: partNumber || null });
    if (id) {
      const { data: m } = await supabaseClient.from('materials').select('id, name, part_number, barcode, brand, cost_price, needs_price, photo_path, kind, pack_qty, pack_label').eq('id', id).maybeSingle();
      existing = m || null;
    }
  }
  let useExisting = !!existing;
  let place = loc === 'vehicle' && vehicles.some(v => v.id === vehicleId) ? { type: 'vehicle', vehicleId } : { type: 'warehouse' };
  // what kind of thing: the label reader's call, else the same word rules the database uses
  const guess = stockKindGuess(label.name || label.description || '', label.category);
  const kindGuess = { kind: ['part', 'cable', 'consumable'].includes(label.kind) ? label.kind : guess.kind, pack_qty: label.pack_qty || guess.packQty || null, pack_label: label.pack_label || guess.packLabel || null };
  const looksTool = label.kind === 'tool' || guess.looksTool;

  overlay.querySelector('.card').innerHTML = `
    <h2 style="margin-bottom:4px;">Scan a part</h2>
    ${read.error ? `<div class="error-box" style="margin-bottom:8px;">${escapeHtml(read.error)} Type the details in instead.</div>` : (label.not_a_part ? `<div class="error-box" style="margin-bottom:8px;">That photo does not look like a part or a label. Type the details in, or cancel and try again.</div>` : '')}
    ${label.confidence === 'low' && !label.not_a_part ? `<p class="subtitle" style="margin-bottom:8px;">The label was hard to read: check the part number and barcode.</p>` : ''}
    <div style="display:flex; gap:10px; align-items:flex-start;">
      <img src="${preview}" alt="Label" style="width:84px; height:84px; object-fit:cover; border-radius:8px; border:1px solid var(--border); flex:none;" />
      <div style="flex:1; min-width:0;">
        <div id="ss-existing"></div>
        <label style="margin-top:0">Name</label>
        <input id="ss-name" value="${escapeHtml(label.name || label.description || '')}" placeholder="e.g. Clipsal 56C320 20A socket" />
      </div>
    </div>
    <div class="grid cols-3">
      <div><label style="font-size:12px;">Brand</label><input id="ss-brand" value="${escapeHtml(label.brand)}" /></div>
      <div><label style="font-size:12px;">Part number</label><input id="ss-part" value="${escapeHtml(partNumber)}" autocapitalize="characters" /></div>
      <div><label style="font-size:12px;">Barcode</label><input id="ss-barcode" value="${escapeHtml(barcode)}" inputmode="numeric" /></div>
    </div>
    ${looksTool ? `<div class="error-box" style="margin-top:8px;">Looks like a tool. Tools go in the Tools register (buy it on a PO and mark the line as a tool), not Stock.</div>` : ''}
    <div id="ss-kind-fields">${stockKindFieldsHtml('ss', kindGuess)}</div>
    <label>Where is it?</label>
    <div id="ss-places" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
    ${askTook ? `
    <div class="grid cols-2">
      <div><label style="font-size:12px;">Took for the job <span class="ss-unit"></span></label><input id="ss-took" type="number" inputmode="decimal" step="1" min="1" value="1" /></div>
      <div><label style="font-size:12px;">Left there <span class="ss-unit"></span></label><input id="ss-left" type="number" inputmode="decimal" step="1" min="0" value="0" /></div>
    </div>` : `
    <label>How many here? <span class="ss-unit"></span></label>
    <input id="ss-qty" type="number" inputmode="decimal" step="1" min="0" value="1" />`}
    <p class="subtitle" style="margin-top:8px; font-size:12px;" id="ss-note"></p>
    <div style="margin-top:12px; display:flex; gap:8px;">
      <button id="ss-save" style="flex:1; ${bigBtn}">Save</button>
      <button type="button" class="secondary" id="ss-cancel" style="${bigBtn}">Cancel</button>
    </div>
    <div id="ss-msg"></div>`;

  function renderExisting() {
    const el = q('#ss-existing');
    if (!existing) { el.innerHTML = ''; return; }
    el.innerHTML = useExisting
      ? `<div style="border:1px solid var(--green); border-radius:8px; padding:6px 8px; margin-bottom:6px; font-size:13px;">Already in Stock: <strong>${escapeHtml(existing.name)}</strong>${existing.needs_price ? ' <span class="badge draft" style="color:var(--red);">Needs a price</span>' : ` (${money(existing.cost_price)})`}<br><span class="subtitle">The count is added to it.</span> <a href="#" id="ss-not-same" class="link-quiet">Not the same item?</a></div>`
      : `<p class="subtitle" style="margin-bottom:6px; font-size:12px;">A new item will be made. <a href="#" id="ss-same" class="link-quiet">It is the same as ${escapeHtml(existing.name)}</a></p>`;
    const toggle = el.querySelector('#ss-not-same, #ss-same');
    if (toggle) toggle.addEventListener('click', (e) => { e.preventDefault(); useExisting = !useExisting; renderExisting(); renderNote(); renderKind(); });
  }
  function renderPlaces() {
    renderStockPlaceButtons(q('#ss-places'), vehicles, place, (p) => { place = p; renderPlaces(); });
  }
  function renderNote() {
    q('#ss-note').textContent = useExisting ? '' : 'Saved at $0 and flagged Needs a price. A price list or a bill with this part number prices it by itself; Admin can set it on the Stock page too.';
  }
  // the kind boxes: hidden for an item already in Stock (its kind is set on the Stock page); cable counts in metres
  function renderKind() {
    q('#ss-kind-fields').style.display = useExisting ? 'none' : '';
    const k = useExisting ? existing : readStockKindFields(overlay, 'ss');
    overlay.querySelectorAll('.ss-unit').forEach(el => { el.textContent = stockIsDrumItem(k) || (k.kind === 'cable') ? '(metres on the drum)' : ''; });
  }
  wireStockKindFields(overlay, 'ss');
  q('#ss-kind').addEventListener('change', renderKind);
  renderExisting(); renderPlaces(); renderNote(); renderKind();
  if (useExisting) q('#ss-name').value = existing.name;

  q('#ss-cancel').addEventListener('click', () => { URL.revokeObjectURL(preview); overlay.remove(); });
  q('#ss-save').addEventListener('click', async () => {
    const msg = q('#ss-msg');
    const btn = q('#ss-save');
    const took = askTook ? Math.max(1, parseFloat(q('#ss-took').value) || 1) : null;
    const left = askTook ? Math.max(0, parseFloat(q('#ss-left').value) || 0) : null;
    const quantity = askTook ? took + left : Math.max(0, parseFloat(q('#ss-qty').value) || 0);
    const kindFields = useExisting ? {} : readStockKindFields(overlay, 'ss');
    const payload = {
      material_id: useExisting ? existing.id : null, force_new: !!existing && !useExisting,
      name: q('#ss-name').value.trim(), part_number: q('#ss-part').value.trim() || null, barcode: q('#ss-barcode').value.trim() || null,
      brand: q('#ss-brand').value.trim() || null, category: label.category || null, photo_path: null,
      location_type: place.type, vehicle_id: place.type === 'vehicle' ? place.vehicleId : null, quantity,
      set_count: askTook, ...kindFields,
    };
    if (!payload.material_id && !payload.name) { msg.innerHTML = '<div class="error-box">Give the part a name.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Saving...';
    // the photo is kept only once the person saves, and only when the item has none yet (already shrunk, so straight up)
    if (!(useExisting && existing.photo_path)) {
      const path = `stock/labels/${Date.now()}-${(small.name || 'label.jpg').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await supabaseClient.storage.from('project-documents').upload(path, small);
      payload.photo_path = upErr ? null : path;
    }
    const { data, error } = await supabaseClient.rpc('material_add_from_scan', { p: payload });
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; btn.disabled = false; btn.textContent = 'Save'; return; }
    URL.revokeObjectURL(preview);
    overlay.remove();
    const unit = data.kind === 'cable' ? 'm' : '';
    showToast(data.existed ? `${data.name}: ${askTook ? 'count set to' : ''} ${poQty(quantity)}${unit}${askTook ? '' : ' added'}` : `${data.name} added to Stock${data.kind === 'cable' ? ' (cable, by the drum)' : data.kind === 'consumable' ? ' (consumable)' : ''}, needs a price`);
    if (onDone) await onDone({ ...data, quantity, took, left });
  });
}
