// Stock kinds and cable drums (docs/IDEAS_BACKLOG.md item 57, spec A12). Loaded on demand by
// supabase-client.js (loadStockKinds) from the Stock page, a vehicle page, the Used stock panel and
// the scan panel.
//
// An item is a part, cable (counted by the drum: the count is metres, each drum its own row in
// material_units with what is left on it) or a consumable (by the pack). The database guesses the
// kind from the name when nobody says (_stock_kind_guess); stockKindGuess is the same rules for a
// chip before anything is saved. Drums are written only through the database steps
// material_unit_set, material_unit_add and stock_transfer_unit.
const STOCK_KIND_LABELS = { part: 'Part', cable: 'Cable: by the drum', consumable: 'Consumable: by the pack' };
// STOCK_TOOL_WORDS (the tool hint) lives in supabase-client.js, which is always loaded first.

// Same rules as the database's _stock_kind_guess: { kind, packQty, packLabel, looksTool }.
function stockKindGuess(name, category) {
  const t = `${name || ''} ${category || ''}`.toLowerCase();
  const cableWord = /\b(cable|cables|tps|twin and earth|twin & earth|t&e|t\+e|circular|building wire|earth wire|flex|flexible cord|cat ?6a?|cat ?5e?|data|coax|coaxial|rg6|solar dc|dc cable|pv wire|welding|xlpe|sdi|single core|orange circ)\b/.test(t)
    || /\b(cable|cables|cabling)\b/.test((category || '').toLowerCase());
  const length = /\b(drum|drums|coil|coils|reel|reels|roll|rolls)\b/.test(t) || /\b\d{2,4} ?(m|mtr|mtrs|metre|metres|meter|meters)\b/.test(t);
  let kind = 'part', packQty = null, packLabel = null;
  if (cableWord && length) {
    kind = 'cable';
    const len = t.match(/\b(\d{2,4}) ?(m|mtr|mtrs|metre|metres|meter|meters)\b/);
    if (len && Number(len[1]) >= 20) packQty = Number(len[1]);
  } else if (/\b(bag|bags|box|boxes|pack|packs|packet|pkt|pk|tub|jar|carton|ctn|sleeve)( of)? ?\d{1,4}\b/.test(t)
    || /\b\d{1,4} ?(pk|pcs|pce|pack|per bag|per box)\b/.test(t)
    || /\b(zip tie|zip ties|cable tie|cable ties|saddle|saddles|wall plug|wall plugs|gyprock screw|tek screw|screws|nails|anchors|silicone|sealant|tape|glands?|wago|bp connector|bp connectors|scotchlok|lugs?|crimp lugs?)\b/.test(t)) {
    kind = 'consumable';
    const pk = t.match(/\b((bag|box|pack|packet|pkt|pk|tub|jar|carton|ctn|sleeve)( of)? ?\d{1,4})\b/) || t.match(/\b(\d{1,4} ?(pk|pcs|pce|pack))\b/);
    if (pk) packLabel = pk[1];
  }
  return { kind, packQty, packLabel, looksTool: STOCK_TOOL_WORDS.test(t) };
}

function stockIsDrumItem(m) { return !!m && m.kind === 'cable' && Number(m.pack_qty) > 0; }

// The chip on a row: "Cable: drum of 100m", "Consumable: bag of 100".
function stockKindChip(m) {
  if (!m) return '';
  if (m.kind === 'part' && stockKindGuess(m.name, m.category).kind === 'cable') return `<span class="badge draft" style="color:var(--amber);" title="Edit, What kind of item = Cable: counted by the drum from then on (the count and price so far are per drum and are converted)">Looks like cable, set it up?</span>`;
  if (m.kind === 'cable') return `<span class="badge draft" title="Counted by the drum: the count is metres, each drum shown with what is left on it">Cable: drum of ${escapeHtml(poQty(m.pack_qty || 100))}m</span>`;
  if (m.kind === 'consumable') return `<span class="badge draft" title="Counted by the pack, never asked about at clock-out">Consumable${m.pack_label ? ': ' + escapeHtml(m.pack_label) : ''}</span>`;
  return '';
}

// Kind, drum size and pack size boxes for the Stock edit panel and the scan panel.
function stockKindFieldsHtml(prefix, m) {
  const kind = m?.kind || 'part';
  return `<label>What kind of item</label>
    <select id="${prefix}-kind">${Object.entries(STOCK_KIND_LABELS).map(([k, l]) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div id="${prefix}-pack-cable" style="${kind === 'cable' ? '' : 'display:none;'}">
      <label>Metres on a full drum</label>
      <input id="${prefix}-pack-qty" type="number" inputmode="decimal" step="1" min="1" value="${escapeHtml(m?.pack_qty || 100)}" />
      <p class="subtitle" style="font-size:12px; margin:2px 0 0;">The count is metres. A PO line is one drum; a bill priced per drum is kept per metre.${m?.id && m.kind !== 'cable' ? ' Switching an existing item: its count so far is read as drums and its cost as per drum, both converted on Save.' : ''}</p>
    </div>
    <div id="${prefix}-pack-consumable" style="${kind === 'consumable' ? '' : 'display:none;'}">
      <label>Pack</label>
      <input id="${prefix}-pack-label" placeholder="e.g. bag of 100" value="${escapeHtml(m?.pack_label)}" />
      <p class="subtitle" style="font-size:12px; margin:2px 0 0;">Counted by the pack, never asked about at clock-out (zip ties, saddles, tape).</p>
    </div>`;
}
function wireStockKindFields(root, prefix) {
  const sel = root.querySelector(`#${prefix}-kind`);
  const show = () => {
    root.querySelector(`#${prefix}-pack-cable`).style.display = sel.value === 'cable' ? '' : 'none';
    root.querySelector(`#${prefix}-pack-consumable`).style.display = sel.value === 'consumable' ? '' : 'none';
  };
  sel.addEventListener('change', show);
  show();
}
function readStockKindFields(root, prefix) {
  const kind = root.querySelector(`#${prefix}-kind`).value;
  return {
    kind,
    pack_qty: kind === 'cable' ? (parseFloat(root.querySelector(`#${prefix}-pack-qty`).value) || 100) : null,
    pack_label: kind === 'consumable' ? (root.querySelector(`#${prefix}-pack-label`).value.trim() || null) : null,
  };
}

// Drums at a place (or everywhere when loc is not given), newest last.
async function loadDrums({ materialIds = null, loc = null, vehicleId = null } = {}) {
  let q = supabaseClient.from('material_units').select('id, material_id, location_type, vehicle_id, qty_left, pack_qty, label, created_at').order('created_at');
  if (materialIds) q = q.in('material_id', materialIds);
  if (loc) q = q.eq('location_type', loc);
  if (loc === 'vehicle') q = q.eq('vehicle_id', vehicleId);
  const { data } = await q;
  return data || [];
}

// "4 drums, 280m: 2 full, 60m, 20m"
function drumSummary(units, packQty) {
  if (!units.length) return 'no drums';
  const full = units.filter(u => Number(u.qty_left) >= Number(u.pack_qty || packQty) - 0.005).length;
  const parts = units.filter(u => Number(u.qty_left) < Number(u.pack_qty || packQty) - 0.005).map(u => `${poQty(u.qty_left)}m`);
  const total = units.reduce((s, u) => s + Number(u.qty_left), 0);
  return `${units.length} drum${units.length === 1 ? '' : 's'}, ${poQty(total)}m: ${[full ? `${full} full` : '', ...parts].filter(Boolean).join(', ')}`;
}
function drumLabel(u, packQty) {
  return Number(u.qty_left) >= Number(u.pack_qty || packQty) - 0.005 ? `Full drum (${poQty(u.qty_left)}m)` : `${poQty(u.qty_left)}m left${u.label ? ' (' + u.label + ')' : ''}`;
}

// A list of drums as buttons: tap one to set what is left on it (anyone), plus "+ Add a drum".
function drumListHtml(units, m, { loc, vehicleId, placeLabel }) {
  return `<div class="drum-list" data-material-id="${escapeHtml(m.id)}" data-loc="${escapeHtml(loc)}" data-vehicle="${escapeHtml(vehicleId || '')}" style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">
    ${units.map(u => `<button type="button" class="secondary btn-sm drum-btn" data-unit-id="${escapeHtml(u.id)}" data-left="${escapeHtml(u.qty_left)}" title="Tap to set what is left on this drum">${escapeHtml(drumLabel(u, m.pack_qty))}</button>`).join('')}
    <button type="button" class="secondary btn-sm drum-add-btn" title="A drum the app did not know about at ${escapeHtml(placeLabel)}">+ Add a drum</button>
  </div>`;
}
function wireDrumLists(root, materialsById, onChanged) {
  root.querySelectorAll('.drum-list').forEach(list => {
    const m = materialsById[list.dataset.materialId];
    const loc = list.dataset.loc, vehicleId = list.dataset.vehicle || null;
    const placeLabel = loc === 'vehicle' ? 'the van' : 'the Warehouse';
    list.querySelectorAll('.drum-btn').forEach(btn => btn.addEventListener('click', async () => {
      const raw = prompt(`${m.name}: how many metres are left on this drum? (app has ${poQty(btn.dataset.left)}m; 0 means it is finished)`, btn.dataset.left);
      if (raw === null) return;
      const left = Number(raw);
      if (!(left >= 0)) { alert('Enter a number, 0 or more.'); return; }
      if (left === Number(btn.dataset.left)) return;
      const reason = prompt('Why is it different? (e.g. stocktake, used on a job, damaged)', '');
      if (reason === null) return;
      btn.disabled = true;
      const { error } = await supabaseClient.rpc('material_unit_set', { p_unit_id: btn.dataset.unitId, p_left: left, p_reason: reason || null });
      if (error) { alert(friendlyError(error)); btn.disabled = false; return; }
      showToast(left === 0 ? `${m.name}: drum finished` : `${m.name}: drum set to ${poQty(left)}m`);
      if (onChanged) await onChanged();
    }));
    list.querySelector('.drum-add-btn').addEventListener('click', async () => {
      const raw = prompt(`${m.name}: how many metres are on the drum you are adding at ${placeLabel}? (a full one is ${poQty(m.pack_qty)}m)`, String(m.pack_qty));
      if (raw === null) return;
      const metres = Number(raw);
      if (!(metres > 0)) { alert('Enter the metres on the drum.'); return; }
      const reason = prompt('Where did it come from? (e.g. stocktake, bought without a PO)', '');
      if (reason === null) return;
      const { error } = await supabaseClient.rpc('material_unit_add', { p_material_id: m.id, p_loc: loc, p_vehicle_id: vehicleId, p_metres: metres, p_reason: reason || null });
      if (error) { alert(friendlyError(error)); return; }
      showToast(`${m.name}: drum of ${poQty(metres)}m added`);
      if (onChanged) await onChanged();
    });
  });
}

// Which drum did you use? Resolves { unitId, qtyLeft } (unitId null = a full drum the app picks), or null.
function openDrumPickPanel({ material, units, placeLabel }) {
  return new Promise(resolve => {
    const pack = Number(material.pack_qty) || 100;
    const full = units.filter(u => Number(u.qty_left) >= pack - 0.005);
    const open = units.filter(u => Number(u.qty_left) < pack - 0.005);
    const o = openModal(`<h2 style="margin-bottom:4px;">${escapeHtml(material.name)}</h2>
      <p class="subtitle" style="margin-bottom:10px;">Which drum did you use in ${escapeHtml(placeLabel)}?</p>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <button type="button" class="drum-pick" data-unit="" data-left="${pack}" style="${STOCK_BIG_BTN} text-align:left;">A full drum (${poQty(pack)}m)${full.length ? ` <span class="subtitle">(${full.length} here)</span>` : ' <span class="subtitle">(the app has none here, one is added)</span>'}</button>
        ${open.map(u => `<button type="button" class="secondary drum-pick" data-unit="${escapeHtml(u.id)}" data-left="${escapeHtml(u.qty_left)}" style="${STOCK_BIG_BTN} text-align:left;">The drum with ${poQty(u.qty_left)}m on it${u.label ? ` <span class="subtitle">(${escapeHtml(u.label)})</span>` : ''}</button>`).join('')}
        <button type="button" class="secondary" id="drum-pick-cancel" style="${STOCK_BIG_BTN}">Cancel</button>
      </div>`, { maxWidth: 440 });
    o.querySelector('#drum-pick-cancel').addEventListener('click', () => { o.remove(); resolve(null); });
    o.querySelectorAll('.drum-pick').forEach(b => b.addEventListener('click', () => { o.remove(); resolve({ unitId: b.dataset.unit || null, qtyLeft: Number(b.dataset.left) }); }));
  });
}
