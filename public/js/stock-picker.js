// The Stock / prebuild picker: a search over Stock materials and the prebuild library, used by variations
// on the job page (project.html, js/variation-fixed-editor.js) and by items added to a do-and-charge invoice
// (js/project-invoice-actuals.js). Loaded on demand by loadStockPicker (js/supabase-client.js). Resolves to
// { kind: 'material' | 'prebuild', id, name, quantity }, or null if cancelled. Costs only show to pricing roles.
// Needs supabaseClient, getPrebuilds, matchesAllWords, escapeHtml, money, openModal (js/supabase-client.js).

// Resolves to
// { kind: 'material' | 'prebuild', id, name, quantity }, or null if cancelled.
// Costs only show to pricing roles.
async function openVariationStockPicker(pricingVisible, priceOnly) {
  const [{ data: materialsData }, prebuilds] = await Promise.all([
    supabaseClient.from('materials').select('id, name, category, cost_price, quantity_on_hand').order('name'),
    getPrebuilds(),
  ]);
  const materials = materialsData || [];
  if (!materials.length && !prebuilds.length) { alert('No materials or prebuilds set up yet. Add stock under the Stock tab.'); return null; }
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:110; padding:16px;';
    overlay.innerHTML = `
      <div class="card" style="max-width:480px; width:100%; max-height:80vh; overflow-y:auto;">
        <h2>Add from Stock</h2>
        <label style="margin-top:0">Quantity</label>
        <input id="vsp-qty" type="number" value="1" min="0.01" step="0.01" style="margin-bottom:12px;" />
        <label>Search</label>
        <input id="vsp-search" placeholder="Name, category..." autocomplete="off" />
        <div id="vsp-results" style="margin-top:8px;"></div>
        <div style="margin-top:16px; text-align:right;"><button type="button" class="secondary" id="vsp-cancel">Cancel</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#vsp-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    const resultsEl = overlay.querySelector('#vsp-results');
    const render = () => {
      const q = overlay.querySelector('#vsp-search').value.trim();
      const pbs = (q ? prebuilds.filter(p => matchesAllWords(`${p.name} ${p.category} ${p.subcategory || ''}`, q)) : prebuilds).slice(0, 25);
      const mts = (q ? materials.filter(m => matchesAllWords(`${m.name} ${m.category || ''}`, q)) : materials).slice(0, 25);
      if (!pbs.length && !mts.length) { resultsEl.innerHTML = `<p class="subtitle">No matches.</p>`; return; }
      resultsEl.innerHTML = [
        ...pbs.map(p => `<div class="vsp-row" data-kind="prebuild" data-id="${p.id}" style="padding:10px; cursor:pointer; border-bottom:0.5px solid var(--border);">
          <div style="font-weight:600;">${escapeHtml(p.name)} <span class="subtitle" style="font-weight:400;">Prebuild</span></div>
          <div class="subtitle" style="font-size:12px;">${escapeHtml(p.category || '')}${p.subcategory ? ' / ' + escapeHtml(p.subcategory) : ''}</div></div>`),
        ...mts.map(m => `<div class="vsp-row" data-kind="material" data-id="${m.id}" style="padding:10px; cursor:pointer; border-bottom:0.5px solid var(--border);">
          <div style="font-weight:600;">${escapeHtml(m.name)} <span class="subtitle" style="font-weight:400;">${pricingVisible ? money(m.cost_price) + ' - ' : ''}${qtyOnHand(m)} in stock</span></div>
          <div class="subtitle" style="font-size:12px;">${escapeHtml(m.category || '')}</div></div>`),
      ].join('');
      resultsEl.querySelectorAll('.vsp-row').forEach(row => row.addEventListener('click', () => {
        const qty = parseFloat(overlay.querySelector('#vsp-qty').value) || 0;
        if (!(qty > 0)) { alert('Enter a quantity first.'); return; }
        if (row.dataset.kind === 'material') {
          const m = materials.find(x => x.id === row.dataset.id);
          if (!priceOnly && Number(m.quantity_on_hand) < qty && !confirm(`Only ${qtyOnHand(m)} of ${m.name} in stock. Add ${qty} anyway? Stock will go to zero.`)) return;
          done({ kind: 'material', id: m.id, name: m.name, quantity: qty });
        } else {
          const p = prebuilds.find(x => x.id === row.dataset.id);
          done({ kind: 'prebuild', id: p.id, name: p.name, quantity: qty });
        }
      }));
    };
    const qtyOnHand = (m) => Math.round((Number(m.quantity_on_hand) || 0) * 100) / 100;
    overlay.querySelector('#vsp-search').addEventListener('input', render);
    render();
  });
}
