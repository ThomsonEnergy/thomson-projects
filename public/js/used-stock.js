// Used stock on a job (Stock from My Day, spec A12; docs/PO_REVIEW.md delivery 3). Loaded on demand
// by supabase-client.js (loadUsedStock) from My Day's "Used stock on this job" button and the
// clock-out question "Did you take any stock?". Where it came from (the van assigned to you first),
// what, how many, and how many are left there (prefilled from the app's count, so a wrong count is fixed on the spot). A part
// not in Stock yet is added with a name and flagged "Needs a price", or by a photo of its label
// (js/stock-scan.js, loaded on demand, item 44). Makes a closed stock PO through
// po_create_stock_pull, costed to the job. Consumables (counted by the pack) are not asked about;
// they get a one-tap "Running low" instead.
const USED_STOCK_SOURCE_KEY = 'teops-used-stock-source';
const USED_STOCK_RECENT_KEY = 'teops-used-stock-recent';
async function openUsedStockPanel({ projectId, jobLabel, onDone }) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const [vehicles, { data: materials }, { data: mine }] = await Promise.all([
    stockVehicles(),
    supabaseClient.from('materials').select('id, name, is_consumable, pack_label, needs_price').order('name'),
    supabaseClient.from('fleet_vehicles').select('id').eq('assigned_staff_id', user.id).eq('holds_stock', true).limit(1).maybeSingle(),
  ]);
  const allMats = materials || [];
  const parts = allMats.filter(m => !m.is_consumable);
  const consumables = allMats.filter(m => m.is_consumable);
  let source = lsGet(USED_STOCK_SOURCE_KEY, null);
  const valid = (s) => s && (s.type === 'warehouse' || (s.type === 'vehicle' && vehicles.some(v => v.id === s.vehicleId)));
  if (mine?.id && vehicles.some(v => v.id === mine.id)) source = valid(source) ? source : { type: 'vehicle', vehicleId: mine.id };
  if (!valid(source)) source = { type: 'warehouse' };
  const recent = lsGet(USED_STOCK_RECENT_KEY, []);
  const picked = [];   // { materialId, newName, name, qty, left, leftTouched }
  const low = new Set();
  let have = {};
  const placeLabel = () => source.type === 'vehicle' ? (vehicles.find(v => v.id === source.vehicleId)?.vehicle_name || vehicles.find(v => v.id === source.vehicleId)?.rego || 'the van') : 'Warehouse';
  const bigBtn = STOCK_BIG_BTN;

  const overlay = openModal(`
    <h2 style="margin-bottom:4px;">Stock used on ${escapeHtml(jobLabel || 'this job')}</h2>
    <p class="subtitle" style="margin-bottom:10px;">Goes on the job's costs and keeps the counts right.</p>
    <label style="margin-top:0">Where did it come from?</label>
    <div id="us-sources" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;"></div>
    <label>What did you take?</label>
    <input id="us-search" placeholder="Type part of the name..." autocomplete="off" />
    <div id="us-results"></div>
    <div id="us-picked" style="margin-top:8px;"></div>
    <button type="button" class="secondary" id="us-add-new" style="margin-top:6px; ${bigBtn}">Not in Stock? + Add it</button>
    <div id="us-new" style="display:none; border:1px solid var(--border); border-radius:8px; padding:8px; margin-top:6px;">
      <button type="button" class="secondary" id="us-new-photo" style="width:100%; ${bigBtn}">&#128247; Take a photo of the label</button>
      <p class="subtitle" style="margin:6px 0 2px; font-size:12px;">Or type it in:</p>
      <input id="us-new-name" placeholder="What is it? e.g. 20mm conduit saddle" />
      <div class="grid cols-2" style="margin-top:6px;">
        <div><label style="margin-top:0; font-size:12px;">Took</label><input id="us-new-qty" type="number" inputmode="numeric" step="1" min="1" value="1" /></div>
        <div><label style="margin-top:0; font-size:12px;">Left there</label><input id="us-new-left" type="number" inputmode="numeric" step="1" min="0" value="0" /></div>
      </div>
      <button type="button" id="us-new-ok" style="margin-top:6px; ${bigBtn}">Add it</button>
    </div>
    ${consumables.length ? `
    <details style="margin-top:12px;"><summary class="subtitle" style="cursor:pointer;">Anything running low? (zip ties, saddles, tape...)</summary>
      <div id="us-low" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
        ${consumables.map(c => `<button type="button" class="secondary btn-sm us-low-btn" data-id="${c.id}">${escapeHtml(c.name)}${c.pack_label ? ' <span class="subtitle">(' + escapeHtml(c.pack_label) + ')</span>' : ''}</button>`).join('')}
      </div>
    </details>` : ''}
    <div style="margin-top:14px; display:flex; gap:8px;">
      <button id="us-done" style="flex:1; ${bigBtn}">Done</button>
      <button type="button" class="secondary" id="us-cancel" style="${bigBtn}">Cancel</button>
    </div>
    <div id="us-msg"></div>`, { maxWidth: 520 });

  const q = (sel) => overlay.querySelector(sel);
  function renderSources() {
    renderStockPlaceButtons(q('#us-sources'), vehicles, source, async (s) => {
      source = s;
      have = await loadPlaceCounts(source.type, source.vehicleId);
      picked.forEach(p => { p.leftTouched = false; });
      renderSources(); renderPicked();
    });
  }
  function addPick(m) {
    const found = picked.find(p => p.materialId === m.id);
    if (found) { found.qty += 1; }
    else picked.push({ materialId: m.id, name: m.name, qty: 1, leftTouched: false, needsPrice: m.needs_price });
    lsSet(USED_STOCK_RECENT_KEY, [m.id, ...recent.filter(id => id !== m.id)].slice(0, 10));
    q('#us-search').value = ''; renderResults(''); renderPicked();
  }
  function renderResults(text) {
    const el = q('#us-results');
    const query = text.trim().toLowerCase();
    let list;
    if (query.length < 2) list = recent.map(id => parts.find(m => m.id === id)).filter(Boolean).filter(m => !picked.some(p => p.materialId === m.id)).slice(0, 6);
    else list = parts.filter(m => matchesAllWords(m.name, query) && !picked.some(p => p.materialId === m.id)).slice(0, 8);
    if (!list.length) { el.innerHTML = query.length >= 2 ? '<p class="subtitle" style="font-size:12px; margin:4px 0;">Nothing in Stock by that name. Use "Not in Stock? + Add it".</p>' : ''; return; }
    el.innerHTML = `${query.length < 2 ? '<p class="subtitle" style="font-size:12px; margin:6px 0 2px;">Recent</p>' : ''}<div style="display:flex; flex-direction:column; gap:4px;">${list.map(m => `<button type="button" class="secondary us-pick" data-id="${m.id}" style="text-align:left; ${bigBtn}">${escapeHtml(m.name)} <span class="subtitle">(${poQty(have[m.id] || 0)} in ${escapeHtml(placeLabel())})</span></button>`).join('')}</div>`;
    el.querySelectorAll('.us-pick').forEach(b => b.addEventListener('click', () => addPick(parts.find(m => m.id === b.dataset.id))));
  }
  function renderPicked() {
    const el = q('#us-picked');
    if (!picked.length) { el.innerHTML = ''; return; }
    el.innerHTML = picked.map((p, i) => {
      const h = p.materialId ? (have[p.materialId] || 0) : 0;
      if (!p.leftTouched && p.materialId) p.left = Math.max(0, Math.round((h - p.qty) * 100) / 100);
      return `<div class="us-line" data-i="${i}" style="border:1px solid var(--border); border-radius:8px; padding:8px; margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
          <strong style="font-size:14px;">${escapeHtml(p.name)}${p.newName ? ' <span class="badge draft">New, needs a price</span>' : ''}</strong>
          <button type="button" class="secondary btn-sm us-remove">&times;</button>
        </div>
        <div style="display:flex; gap:10px; align-items:end; margin-top:6px; flex-wrap:wrap;">
          <div><label style="margin-top:0; font-size:12px;">Took</label>
            <div style="display:flex; gap:4px; align-items:center;">
              <button type="button" class="secondary us-minus" style="min-width:44px; ${bigBtn}">&minus;</button>
              <input class="us-qty" type="number" inputmode="numeric" step="1" min="1" value="${p.qty}" style="width:64px; text-align:center;" />
              <button type="button" class="secondary us-plus" style="min-width:44px; ${bigBtn}">+</button>
            </div></div>
          <div style="flex:1; min-width:120px;"><label style="margin-top:0; font-size:12px;">Left in ${escapeHtml(placeLabel())}? <span class="subtitle">(app had ${poQty(h)})</span></label>
            <input class="us-left" type="number" inputmode="numeric" step="1" min="0" value="${p.left ?? ''}" /></div>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.us-line').forEach(line => {
      const p = picked[Number(line.dataset.i)];
      const qtyEl = line.querySelector('.us-qty'), leftEl = line.querySelector('.us-left');
      const sync = () => { p.qty = Math.max(1, parseInt(qtyEl.value, 10) || 1); qtyEl.value = p.qty; if (!p.leftTouched && p.materialId) { p.left = Math.max(0, (have[p.materialId] || 0) - p.qty); leftEl.value = p.left; } };
      line.querySelector('.us-minus').addEventListener('click', () => { qtyEl.value = Math.max(1, p.qty - 1); sync(); });
      line.querySelector('.us-plus').addEventListener('click', () => { qtyEl.value = p.qty + 1; sync(); });
      qtyEl.addEventListener('input', sync);
      leftEl.addEventListener('input', () => { p.leftTouched = true; p.left = leftEl.value === '' ? null : Math.max(0, parseFloat(leftEl.value) || 0); });
      line.querySelector('.us-remove').addEventListener('click', () => { picked.splice(Number(line.dataset.i), 1); renderPicked(); renderResults(q('#us-search').value); });
    });
  }

  have = await loadPlaceCounts(source.type, source.vehicleId);
  renderSources(); renderResults(''); renderPicked();
  q('#us-search').addEventListener('input', (e) => renderResults(e.target.value));
  q('#us-add-new').addEventListener('click', () => { q('#us-new').style.display = 'block'; q('#us-new-name').focus(); });
  q('#us-new-photo').addEventListener('click', async () => {
    // the item is made (or found by its barcode) with took + left at this place, then taken like any picked item
    try { await loadStockScan(); } catch (err) { q('#us-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; return; }
    openStockScanPanel({ loc: source.type, vehicleId: source.vehicleId, askTook: true, onDone: async (r) => {
      have = await loadPlaceCounts(source.type, source.vehicleId);
      const found = picked.find(p => p.materialId === r.material_id);
      if (found) { found.qty += r.took; found.leftTouched = false; }
      else picked.push({ materialId: r.material_id, name: r.name, qty: r.took, left: r.left, leftTouched: true, needsPrice: r.needs_price });
      if (!parts.some(m => m.id === r.material_id)) parts.push({ id: r.material_id, name: r.name, needs_price: r.needs_price });
      q('#us-new').style.display = 'none';
      renderPicked();
    } });
  });
  q('#us-new-ok').addEventListener('click', () => {
    const name = q('#us-new-name').value.trim();
    if (!name) { q('#us-new-name').focus(); return; }
    const existing = allMats.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (existing && !existing.is_consumable) { addPick(existing); }
    else picked.push({ newName: name, name, qty: Math.max(1, parseInt(q('#us-new-qty').value, 10) || 1), left: Math.max(0, parseInt(q('#us-new-left').value, 10) || 0), leftTouched: true });
    q('#us-new').style.display = 'none'; q('#us-new-name').value = ''; q('#us-new-qty').value = '1'; q('#us-new-left').value = '0';
    renderPicked();
  });
  overlay.querySelectorAll('.us-low-btn').forEach(b => b.addEventListener('click', () => {
    if (low.has(b.dataset.id)) { low.delete(b.dataset.id); b.classList.add('secondary'); } else { low.add(b.dataset.id); b.classList.remove('secondary'); }
  }));
  q('#us-cancel').addEventListener('click', () => overlay.remove());
  // The Stock PO once it has committed: a second press of Done (after a failed Running-low flag)
  // never makes a second PO and never costs the job twice (bug F54).
  let pulled = null;
  q('#us-done').addEventListener('click', async () => {
    const msg = q('#us-msg');
    const btn = q('#us-done');
    if (!pulled) {
      if (!picked.length && !low.size) { msg.innerHTML = '<div class="error-box">Pick what you took, or Cancel.</div>'; return; }
      for (const p of picked) if (p.left == null || p.left < 0) { msg.innerHTML = `<div class="error-box">Say how many ${escapeHtml(p.name)} are left in ${escapeHtml(placeLabel())}.</div>`; return; }
    }
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      let po = pulled;
      if (picked.length && !po) {
        const { data, error } = await supabaseClient.rpc('po_create_stock_pull', {
          p_project_id: projectId, p_cost_centre_id: null, p_source: source.type, p_vehicle_id: source.type === 'vehicle' ? source.vehicleId : null,
          p_lines: picked.map(p => ({ material_id: p.materialId || null, new_name: p.newName || null, quantity: p.qty, left_after: p.left })),
          p_description: `Stock used on site (My Day)`,
        });
        if (error) throw error;
        po = data;
        pulled = po;
        // The picks are in: nothing above the flags can change any more
        overlay.querySelectorAll('#us-sources button, #us-search, #us-results button, #us-picked input, #us-picked button, #us-add-new, #us-new input, #us-new button').forEach(el => { el.disabled = true; });
      }
      // Each flag that saves comes off the list, so a retry only redoes the ones that failed
      let flagError = null;
      for (const id of [...low]) {
        const { error } = await supabaseClient.rpc('stock_flag_low', { p_material_id: id, p_loc: source.type, p_vehicle_id: source.type === 'vehicle' ? source.vehicleId : null, p_note: null });
        if (error) { flagError = error; continue; }
        low.delete(id);
        const flagBtn = overlay.querySelector(`.us-low-btn[data-id="${id}"]`);
        if (flagBtn) flagBtn.disabled = true;
      }
      if (flagError) {
        msg.innerHTML = `<div class="error-box">${po ? `Stock PO ${escapeHtml(po.po_number)} is made and costed to ${escapeHtml(jobLabel || 'the job')}. ` : ''}The Running-low flag did not save: ${escapeHtml(friendlyError(flagError))} Press ${po ? 'Flag again' : 'Done'} to retry it${po ? ', or Close' : ''}.</div>`;
        btn.disabled = false; btn.textContent = po ? 'Flag again' : 'Done';
        if (po) { const cancel = q('#us-cancel'); cancel.textContent = 'Close'; cancel.onclick = async () => { overlay.remove(); if (onDone) await onDone(po); }; }
        return;
      }
      lsSet(USED_STOCK_SOURCE_KEY, source);
      overlay.remove();
      const needs = (po && po.needs_price && po.needs_price.length) ? ` ${po.needs_price.join(', ')} added to Stock, Admin to price.` : '';
      showToast(po ? `Stock PO ${po.po_number} made, costed to ${jobLabel || 'the job'}.${needs}` : `Running low flagged: Admin has been told.`);
      if (onDone) await onDone(po);
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false; btn.textContent = 'Done';
    }
  });
}
