// Stocktake and Move stock panels (spec A12). Loaded on demand by supabase-client.js
// (loadStockPanels) from the Stock page (Stocktake (Warehouse)) and a vehicle page (Stocktake, Move
// stock here from Warehouse). Both need js/stock-kinds.js (loaded first) for cable drums (item 57).
//
// Stocktake of one place: every item with stock there (plus any you search for), type the real count,
// one Save. Consumables are OK / Low / Out, no numbers. Cable is drum by drum: metres left on each,
// plus any drum the app did not know about (item 57). Differences are logged as count corrections.
async function openStocktakePanel({ loc, vehicleId, placeLabel, onDone }) {
  await loadStockKinds();
  const [{ data: materials }, have, drums] = await Promise.all([
    supabaseClient.from('materials').select('id, name, is_consumable, pack_label, kind, pack_qty').order('name'),
    loadPlaceCounts(loc, vehicleId),
    loadDrums({ loc, vehicleId }),
  ]);
  const all = materials || [];
  const listed = new Set(all.filter(m => (have[m.id] || 0) > 0 || m.is_consumable || drums.some(u => u.material_id === m.id)).map(m => m.id));
  const states = {};
  const drumStates = {};   // unit id -> metres typed
  const newDrums = {};     // material id -> [metres typed for drums the app did not know]
  const overlay = openModal(`
    <h2>Stocktake: ${escapeHtml(placeLabel)}</h2>
    <p class="subtitle" style="margin-bottom:10px;">Walk through and type what is really there. Consumables are just OK, Low or Out. Nothing changes until Save.</p>
    <input id="st-search" placeholder="Add an item that is here but not listed..." autocomplete="off" />
    <div id="st-results"></div>
    <div id="st-list" style="margin-top:8px;"></div>
    <div style="margin-top:14px; display:flex; gap:8px;">
      <button id="st-save" style="flex:1; min-height:44px;">Save stocktake</button>
      <button type="button" class="secondary" id="st-cancel" style="min-height:44px;">Cancel</button>
    </div>
    <div id="st-msg"></div>`, { maxWidth: 560 });
  const q = (sel) => overlay.querySelector(sel);
  function renderList() {
    const items = all.filter(m => listed.has(m.id));
    q('#st-list').innerHTML = items.length ? items.map(m => stockIsDrumItem(m)
      ? `<div style="padding:6px 0; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;"><span>${escapeHtml(m.name)} <span class="subtitle">(app: ${poQty(have[m.id] || 0)}m on ${drums.filter(u => u.material_id === m.id).length} drum${drums.filter(u => u.material_id === m.id).length === 1 ? '' : 's'})</span></span>
            <button type="button" class="secondary btn-sm st-add-drum" data-id="${m.id}">+ Drum</button></div>
          ${drums.filter(u => u.material_id === m.id).map(u => `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:3px 0 3px 12px;"><span class="subtitle">Metres left on the drum (app: ${poQty(u.qty_left)}m)</span>
            <input class="st-drum" data-unit-id="${u.id}" type="number" inputmode="decimal" step="1" min="0" value="${drumStates[u.id] ?? u.qty_left}" style="width:90px; text-align:center;" /></div>`).join('')}
          ${(newDrums[m.id] || []).map((v, i) => `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:3px 0 3px 12px;"><span class="subtitle">New drum, metres on it</span>
            <input class="st-new-drum" data-id="${m.id}" data-i="${i}" type="number" inputmode="decimal" step="1" min="0" value="${v}" style="width:90px; text-align:center;" /></div>`).join('')}
        </div>`
      : m.is_consumable
      ? `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:6px 0; border-top:1px solid var(--border); flex-wrap:wrap;">
          <span>${escapeHtml(m.name)}${m.pack_label ? ` <span class="subtitle">(${escapeHtml(m.pack_label)})</span>` : ''}</span>
          <span style="display:flex; gap:4px;">${['ok', 'low', 'out'].map(s => `<button type="button" class="${states[m.id] === s ? '' : 'secondary'} btn-sm st-state" data-id="${m.id}" data-state="${s}">${s === 'ok' ? 'OK' : s === 'low' ? 'Low' : 'Out'}</button>`).join('')}</span>
        </div>`
      : `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:6px 0; border-top:1px solid var(--border);">
          <span>${escapeHtml(m.name)} <span class="subtitle">(app: ${poQty(have[m.id] || 0)})</span></span>
          <input class="st-count" data-id="${m.id}" type="number" inputmode="numeric" step="1" min="0" value="${states[m.id] ?? (have[m.id] || 0)}" style="width:90px; text-align:center;" />
        </div>`).join('') : '<p class="subtitle">Nothing is recorded here yet. Search above to add items.</p>';
    q('#st-list').querySelectorAll('.st-state').forEach(b => b.addEventListener('click', () => { states[b.dataset.id] = b.dataset.state; renderList(); }));
    q('#st-list').querySelectorAll('.st-count').forEach(inp => inp.addEventListener('input', () => { states[inp.dataset.id] = inp.value; }));
    q('#st-list').querySelectorAll('.st-drum').forEach(inp => inp.addEventListener('input', () => { drumStates[inp.dataset.unitId] = inp.value; }));
    q('#st-list').querySelectorAll('.st-new-drum').forEach(inp => inp.addEventListener('input', () => { newDrums[inp.dataset.id][Number(inp.dataset.i)] = inp.value; }));
    q('#st-list').querySelectorAll('.st-add-drum').forEach(b => b.addEventListener('click', () => { const m = all.find(x => x.id === b.dataset.id); (newDrums[m.id] = newDrums[m.id] || []).push(m.pack_qty); renderList(); }));
  }
  renderList();
  q('#st-search').addEventListener('input', (e) => {
    const text = e.target.value.trim().toLowerCase();
    const el = q('#st-results');
    if (text.length < 2) { el.innerHTML = ''; return; }
    const list = all.filter(m => !listed.has(m.id) && matchesAllWords(m.name, text)).slice(0, 8);
    el.innerHTML = list.map(m => `<button type="button" class="secondary btn-sm st-add" data-id="${m.id}" style="margin:2px;">${escapeHtml(m.name)}</button>`).join('') || '<p class="subtitle" style="font-size:12px;">No item by that name.</p>';
    el.querySelectorAll('.st-add').forEach(b => b.addEventListener('click', () => { listed.add(b.dataset.id); if (!all.find(m => m.id === b.dataset.id).is_consumable) states[b.dataset.id] = states[b.dataset.id] ?? 0; e.target.value = ''; el.innerHTML = ''; renderList(); }));
  });
  q('#st-cancel').addEventListener('click', () => overlay.remove());
  q('#st-save').addEventListener('click', async () => {
    const btn = q('#st-save'), msg = q('#st-msg');
    const counts = [];
    all.filter(m => listed.has(m.id)).forEach(m => {
      if (stockIsDrumItem(m)) {
        drums.filter(u => u.material_id === m.id).forEach(u => { if (drumStates[u.id] !== undefined && drumStates[u.id] !== '' && Number(drumStates[u.id]) !== Number(u.qty_left)) counts.push({ unit_id: u.id, count: Number(drumStates[u.id]) }); });
        (newDrums[m.id] || []).forEach(v => { if (Number(v) > 0) counts.push({ material_id: m.id, add_unit: Number(v) }); });
      }
      else if (m.is_consumable) { if (states[m.id]) counts.push({ material_id: m.id, state: states[m.id] }); }
      else if (states[m.id] !== undefined && states[m.id] !== '') counts.push({ material_id: m.id, count: Number(states[m.id]) });
    });
    if (!counts.length) { msg.innerHTML = '<div class="error-box">Nothing changed.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Saving...';
    const { data, error } = await supabaseClient.rpc('stock_stocktake', { p_loc: loc, p_vehicle_id: loc === 'vehicle' ? vehicleId : null, p_counts: counts });
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; btn.disabled = false; btn.textContent = 'Save stocktake'; return; }
    overlay.remove();
    showToast(`Stocktake saved: ${data.changed} count${data.changed === 1 ? '' : 's'} corrected${data.low ? `, ${data.low} running low` : ''}`);
    if (onDone) await onDone();
  });
}

// Move gear between the Warehouse and a vehicle in one step (no PO). Fixes the source count on the spot.
// Cable moves drum by drum (item 57).
async function openStockTransferPanel({ fromLoc, fromVehicleId, fromLabel, toLoc, toVehicleId, toLabel, onDone }) {
  await loadStockKinds();
  const [{ data: materials }, have, drums] = await Promise.all([
    supabaseClient.from('materials').select('id, name, is_consumable, pack_label, kind, pack_qty').order('name'),
    loadPlaceCounts(fromLoc, fromVehicleId),
    loadDrums({ loc: fromLoc, vehicleId: fromVehicleId }),
  ]);
  const all = materials || [];
  const picked = [];   // { id, name, qty, left, leftTouched } or a drum { id, name, unitId, qtyLeft }
  const overlay = openModal(`
    <h2>Move stock: ${escapeHtml(fromLabel)} to ${escapeHtml(toLabel)}</h2>
    <p class="subtitle" style="margin-bottom:10px;">Counts move straight away, no PO. If the app's count at ${escapeHtml(fromLabel)} is wrong, fix "Left" and it is corrected.</p>
    <input id="tr-search" placeholder="Type part of the name..." autocomplete="off" />
    <div id="tr-results"></div>
    <div id="tr-picked" style="margin-top:8px;"></div>
    <div style="margin-top:14px; display:flex; gap:8px;">
      <button id="tr-save" style="flex:1; min-height:44px;">Move</button>
      <button type="button" class="secondary" id="tr-cancel" style="min-height:44px;">Cancel</button>
    </div>
    <div id="tr-msg"></div>`, { maxWidth: 520 });
  const q = (sel) => overlay.querySelector(sel);
  function renderPicked() {
    q('#tr-picked').innerHTML = picked.map((p, i) => `<div class="tr-line" data-i="${i}" style="border:1px solid var(--border); border-radius:8px; padding:8px; margin-bottom:6px;">
      <div style="display:flex; justify-content:space-between; align-items:center;"><strong>${escapeHtml(p.name)}${p.unitId ? ` <span class="subtitle">(the drum with ${poQty(p.qtyLeft)}m)</span>` : ''}</strong><button type="button" class="secondary btn-sm tr-remove">&times;</button></div>
      ${p.unitId ? '' : `<div class="grid cols-2" style="margin-top:6px;">
        <div><label style="margin-top:0; font-size:12px;">Moving</label><input class="tr-qty" type="number" inputmode="numeric" step="1" min="1" value="${p.qty}" /></div>
        <div><label style="margin-top:0; font-size:12px;">Left at ${escapeHtml(fromLabel)} <span class="subtitle">(app: ${poQty(have[p.id] || 0)})</span></label><input class="tr-left" type="number" inputmode="numeric" step="1" min="0" value="${p.left ?? ''}" /></div>
      </div>`}</div>`).join('');
    q('#tr-picked').querySelectorAll('.tr-line').forEach(line => {
      const p = picked[Number(line.dataset.i)];
      if (p.unitId) { line.querySelector('.tr-remove').addEventListener('click', () => { picked.splice(Number(line.dataset.i), 1); renderPicked(); }); return; }
      line.querySelector('.tr-qty').addEventListener('input', (e) => { p.qty = Math.max(1, parseInt(e.target.value, 10) || 1); if (!p.leftTouched) { p.left = Math.max(0, (have[p.id] || 0) - p.qty); line.querySelector('.tr-left').value = p.left; } });
      line.querySelector('.tr-left').addEventListener('input', (e) => { p.leftTouched = true; p.left = e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value) || 0); });
      line.querySelector('.tr-remove').addEventListener('click', () => { picked.splice(Number(line.dataset.i), 1); renderPicked(); });
    });
  }
  q('#tr-search').addEventListener('input', (e) => {
    const text = e.target.value.trim().toLowerCase();
    const el = q('#tr-results');
    if (text.length < 2) { el.innerHTML = ''; return; }
    const list = all.filter(m => matchesAllWords(m.name, text) && !picked.some(p => p.id === m.id && !p.unitId)).slice(0, 8);
    el.innerHTML = `<div style="display:flex; flex-direction:column; gap:4px;">${list.map(m => `<button type="button" class="secondary tr-pick" data-id="${m.id}" style="text-align:left; min-height:40px;">${escapeHtml(m.name)} <span class="subtitle">(${poQty(have[m.id] || 0)}${stockIsDrumItem(m) ? 'm' : ''} at ${escapeHtml(fromLabel)})</span></button>`).join('') || '<p class="subtitle" style="font-size:12px;">No item by that name.</p>'}</div>`;
    el.querySelectorAll('.tr-pick').forEach(b => b.addEventListener('click', () => {
      const m = all.find(x => x.id === b.dataset.id);
      e.target.value = ''; el.innerHTML = '';
      if (stockIsDrumItem(m)) {
        // a drum at a time
        const units = drums.filter(u => u.material_id === m.id && !picked.some(p => p.unitId === u.id));
        if (!units.length) { alert(`The app has no drum of ${m.name} at ${fromLabel}. Add one on the Stock page (or a stocktake) first.`); return; }
        openActionSheet(`Which drum of ${m.name}?`, units.map(u => ({ label: drumLabel(u, m.pack_qty), onPick: () => { picked.push({ id: m.id, name: m.name, unitId: u.id, qtyLeft: Number(u.qty_left) }); renderPicked(); } })));
        return;
      }
      picked.push({ id: m.id, name: m.name, qty: 1, left: Math.max(0, (have[m.id] || 0) - 1), leftTouched: false });
      renderPicked();
    }));
  });
  q('#tr-cancel').addEventListener('click', () => overlay.remove());
  q('#tr-save').addEventListener('click', async () => {
    const btn = q('#tr-save'), msg = q('#tr-msg');
    if (!picked.length) { msg.innerHTML = '<div class="error-box">Pick what you are moving.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Moving...';
    try {
      for (const p of picked) {
        if (p.moved) continue; // moved by an earlier attempt: a retry never moves it twice (bug F18)
        const { error } = p.unitId
          ? await supabaseClient.rpc('stock_transfer_unit', { p_unit_id: p.unitId, p_to_loc: toLoc, p_to_vehicle: toLoc === 'vehicle' ? toVehicleId : null })
          : await supabaseClient.rpc('stock_transfer', { p_material_id: p.id, p_qty: p.qty, p_from_loc: fromLoc, p_from_vehicle: fromLoc === 'vehicle' ? fromVehicleId : null, p_to_loc: toLoc, p_to_vehicle: toLoc === 'vehicle' ? toVehicleId : null, p_left_after: p.left });
        if (error) throw new Error(`${p.name}: ${friendlyError(error)}`);
        p.moved = true;
      }
      overlay.remove();
      showToast(`Moved ${picked.length} item${picked.length === 1 ? '' : 's'} to ${toLabel}`);
      if (onDone) await onDone();
    } catch (err) { msg.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; btn.disabled = false; btn.textContent = 'Move'; }
  });
}
