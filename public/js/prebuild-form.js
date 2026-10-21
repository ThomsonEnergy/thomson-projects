// The prebuild form, shared by the Prebuilds page (inline, with the library below it) and the
// quote pages (a popup from the stage's "+ Search material / prebuild" picker, "+ New prebuild":
// saved to the library and added to the stage in one step). One form so the two never drift.
//
// mountPrebuildForm(root, { onSaved }) wires a form already rendered inside `root` (from
// prebuildFormHtml()). openPrebuildForm({ onSaved, prebuild }) opens it in a popup. onSaved gets
// the saved prebuild with its prebuild_components (the shape openStockPicker works from).
// Needs supabase-client.js (supabaseClient, getMaterials, matchesAllWords, money, escapeHtml,
// showToast, friendlyError, openModal).

const PREBUILD_SUBCATEGORIES = {
  Electrical: ['Lighting', 'Power', 'Trenching', 'Cable Runs'],
  Solar: ['Panels', 'Batteries', 'Inverters'],
};

function prebuildFormHtml({ heading = 'Add a prebuild', inPopup = false } = {}) {
  return `
    <h2 class="pb-form-heading">${escapeHtml(heading)}</h2>
    ${inPopup ? `<p class="subtitle" style="margin-bottom:10px;">Saved to the prebuild library and added to this stage.</p>` : ''}
    <div class="grid cols-3">
      <div>
        <label style="margin-top:0">Name</label>
        <input class="pb-name" placeholder="e.g. 70mm Battery Cable - short, quick to recognise" />
      </div>
      <div>
        <label style="margin-top:0">Internal part number (optional)</label>
        <input class="pb-part-number" placeholder="Internal only, not a supplier SKU" />
      </div>
      <div>
        <label style="margin-top:0">Category</label>
        <select class="pb-category">
          ${Object.keys(PREBUILD_SUBCATEGORIES).map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="grid cols-3">
      <div>
        <label style="margin-top:0">Subcategory</label>
        <select class="pb-subcategory"></select>
      </div>
    </div>

    <label>Client-facing description</label>
    <p class="subtitle" style="margin:0 0 8px;">What the client sees on the proposal - not the name above. Add components below first so the AI has something real to describe, or write your own.</p>
    <textarea class="pb-client-desc" style="min-height:110px;" placeholder="e.g. SUPPLY AND INSTALL NEW 70MM BATTERY CABLE&#10;&#10;Supply and installation of..."></textarea>
    <button type="button" class="secondary pb-generate-btn" style="margin-top:8px;">&#10024; Generate with AI</button>
    <button type="button" class="secondary pb-cleanup-btn" style="margin-top:8px;">&#129529; Cleanup with AI</button>
    <p class="subtitle" style="margin:4px 0 0;">Cleanup rewrites the wording/formatting of what's in the box above right now - use it after you've generated a draft and then edited it by hand, instead of generating a fresh one from scratch.</p>
    <div class="pb-generate-msg"></div>

    <label>Components <span style="color:var(--muted); font-weight:400;">(unit costs ex GST)</span></label>
    <div class="pb-components"></div>
    <button type="button" class="secondary pb-add-component" style="margin-top:6px;">+ Add component</button>
    <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="pb-save-btn">Save prebuild</button>
      <button type="button" class="secondary pb-clear-btn">${inPopup ? 'Cancel' : 'Clear form'}</button>
    </div>
    <div class="pb-msg"></div>`;
}

function mountPrebuildForm(root, { onSaved, onCancel } = {}) {
  const $ = (sel) => root.querySelector(sel);
  let editingPrebuildId = null;

  function refreshSubcategoryOptions() {
    const cat = $('.pb-category').value;
    $('.pb-subcategory').innerHTML = (PREBUILD_SUBCATEGORIES[cat] || []).map(s => `<option value="${s}">${s}</option>`).join('');
  }
  $('.pb-category').addEventListener('change', refreshSubcategoryOptions);

  function addComponentRow({ item_type = 'material', description = '', quantity = 1, unit_cost = '' } = {}) {
    const row = document.createElement('div');
    row.className = 'pb-component-row';
    row.style.cssText = 'display:grid; grid-template-columns:2fr 1fr 0.7fr 1fr auto; gap:8px; margin-bottom:6px; align-items:center;';
    row.innerHTML = `
      <div style="position:relative;">
        <input class="pbc-desc" placeholder="e.g. Downlight fitting" value="${escapeHtml(description)}" style="font-size:13px;" autocomplete="off" />
        <div class="pbc-results" style="position:absolute; top:100%; left:0; right:0; z-index:10; background:var(--surface-2); border:1px solid var(--border); border-radius:8px; display:none;"></div>
      </div>
      <select class="pbc-type" style="font-size:13px;">
        <option value="material" ${item_type === 'material' ? 'selected' : ''}>Material</option>
        <option value="labour" ${item_type === 'labour' ? 'selected' : ''}>Labour</option>
      </select>
      <input class="pbc-qty" type="number" inputmode="decimal" step="0.01" value="${escapeHtml(quantity)}" placeholder="Qty/hrs" style="font-size:13px;" />
      <input class="pbc-cost" type="number" inputmode="decimal" step="0.01" value="${escapeHtml(unit_cost)}" placeholder="Unit cost $" style="font-size:13px;" />
      <button type="button" class="secondary pbc-remove" style="padding:6px 10px; font-size:12px;">x</button>
    `;
    row.querySelector('.pbc-remove').addEventListener('click', () => row.remove());

    // Type-ahead against Stock materials, same search-or-type-new pattern as the PO line picker:
    // picking a result fills description + unit cost from Stock; typing without picking keeps it
    // as free text. Materials only (a prebuild inside a prebuild is not a thing here).
    const descInput = row.querySelector('.pbc-desc');
    const costInput = row.querySelector('.pbc-cost');
    const resultsEl = row.querySelector('.pbc-results');
    descInput.addEventListener('input', async () => {
      const q = descInput.value.trim().toLowerCase();
      if (row.querySelector('.pbc-type').value !== 'material' || q.length < 2) { resultsEl.style.display = 'none'; return; }
      const materials = await getMaterials();
      const matches = materials.filter(m => matchesAllWords(m.name, q)).slice(0, 8);
      if (!matches.length) { resultsEl.style.display = 'none'; return; }
      resultsEl.innerHTML = matches.map(m => `<div class="pbc-pick" data-name="${escapeHtml(m.name)}" data-cost="${escapeHtml(m.cost_price)}" style="padding:8px 10px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">${escapeHtml(m.name)} <span class="subtitle">(${money(m.cost_price)})</span></div>`).join('');
      resultsEl.style.display = 'block';
      resultsEl.querySelectorAll('.pbc-pick').forEach(pick => {
        pick.addEventListener('click', () => {
          descInput.value = pick.dataset.name;
          costInput.value = pick.dataset.cost;
          resultsEl.style.display = 'none';
        });
      });
    });
    descInput.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 200));

    $('.pb-components').appendChild(row);
  }
  $('.pb-add-component').addEventListener('click', () => addComponentRow());

  function readComponents(withCosts) {
    return [...root.querySelectorAll('.pb-component-row')].map((row, i) => ({
      item_type: row.querySelector('.pbc-type').value,
      description: row.querySelector('.pbc-desc').value.trim(),
      ...(withCosts ? {
        quantity: parseFloat(row.querySelector('.pbc-qty').value) || 0,
        unit_cost: parseFloat(row.querySelector('.pbc-cost').value) || 0,
        sort_order: i,
      } : {}),
    })).filter(c => c.description);
  }

  function clear() {
    editingPrebuildId = null;
    $('.pb-form-heading').textContent = 'Add a prebuild';
    $('.pb-name').value = '';
    $('.pb-part-number').value = '';
    $('.pb-client-desc').value = '';
    $('.pb-category').value = Object.keys(PREBUILD_SUBCATEGORIES)[0];
    refreshSubcategoryOptions();
    $('.pb-components').innerHTML = '';
    addComponentRow();
    $('.pb-msg').innerHTML = '';
    $('.pb-generate-msg').innerHTML = '';
  }

  function loadForEdit(pb) {
    editingPrebuildId = pb.id;
    $('.pb-form-heading').textContent = `Edit prebuild - ${pb.name}`;
    $('.pb-name').value = pb.name;
    $('.pb-part-number').value = pb.internal_part_number || '';
    $('.pb-client-desc').value = pb.client_description || '';
    $('.pb-category').value = pb.category;
    refreshSubcategoryOptions();
    $('.pb-subcategory').value = pb.subcategory || '';
    $('.pb-components').innerHTML = '';
    (pb.prebuild_components || []).slice().sort((a, b) => a.sort_order - b.sort_order).forEach(addComponentRow);
  }

  $('.pb-clear-btn').addEventListener('click', () => { if (onCancel) onCancel(); else clear(); });

  $('.pb-generate-btn').addEventListener('click', async () => {
    const btn = $('.pb-generate-btn');
    const msg = $('.pb-generate-msg');
    const name = $('.pb-name').value.trim();
    if (!name) { msg.innerHTML = `<div class="error-box">Give it a name first.</div>`; return; }
    btn.disabled = true;
    btn.textContent = 'Generating...';
    msg.innerHTML = '';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/generate-prebuild-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ name, components: readComponents(false) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not generate a description');
      $('.pb-client-desc').value = data.description;
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '✨ Generate with AI';
  });

  $('.pb-cleanup-btn').addEventListener('click', async () => {
    const btn = $('.pb-cleanup-btn');
    const msg = $('.pb-generate-msg');
    const current = $('.pb-client-desc').value.trim();
    if (!current) { msg.innerHTML = `<div class="error-box">Nothing to clean up yet - write or generate a description first.</div>`; return; }
    btn.disabled = true;
    btn.textContent = 'Cleaning up...';
    msg.innerHTML = '';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/cleanup-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          text: current,
          instructions: `This is a client-facing prebuild description for an Australian electrical/solar contractor's quoting system, in this exact house format: an ALL CAPS "SUPPLY AND INSTALL NEW ..." (or similar - matching whatever action the text describes) title line, then a blank line, then one short trade-language paragraph closing with the relevant AS/NZS standard(s). Keep that exact format. Never attribute the work to a specific qualification level (e.g. "licensed electrician", "licensed electrical specialist") - apprentices do this work too.`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not clean this up');
      $('.pb-client-desc').value = data.text;
      msg.innerHTML = `<div class="success-box">Cleaned up.</div>`;
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '\u{1F9F9} Cleanup with AI';
  });

  $('.pb-save-btn').addEventListener('click', async () => {
    const msg = $('.pb-msg');
    const name = $('.pb-name').value.trim();
    if (!name) { msg.innerHTML = `<div class="error-box">Name is required.</div>`; return; }
    const btn = $('.pb-save-btn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const components = readComponents(true);
      const prebuildFields = {
        name,
        internal_part_number: $('.pb-part-number').value.trim(),
        client_description: $('.pb-client-desc').value.trim(),
        category: $('.pb-category').value,
        subcategory: $('.pb-subcategory').value,
      };

      const wasEditing = !!editingPrebuildId;
      let prebuildId = editingPrebuildId;
      let saved;
      if (editingPrebuildId) {
        const { data, error } = await supabaseClient.from('prebuilds').update(prebuildFields).eq('id', editingPrebuildId).select().single();
        if (error) throw error;
        saved = data;
        const { error: delErr } = await supabaseClient.from('prebuild_components').delete().eq('prebuild_id', editingPrebuildId);
        if (delErr) throw delErr;
      } else {
        const { data, error } = await supabaseClient.from('prebuilds').insert(prebuildFields).select().single();
        if (error) throw error;
        saved = data;
        prebuildId = data.id;
      }

      let savedComponents = [];
      if (components.length) {
        const { data, error: compErr } = await supabaseClient
          .from('prebuild_components')
          .insert(components.map(c => ({ ...c, prebuild_id: prebuildId })))
          .select();
        if (compErr) throw compErr;
        savedComponents = data || [];
      }

      clear();
      showToast(wasEditing ? `Updated ${name}.` : `Saved ${name} to the prebuild library.`);
      if (onSaved) await onSaved({ ...saved, prebuild_components: savedComponents }, { wasEditing });
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  clear();
  return { clear, loadForEdit };
}

// Popup version, used from a quote stage's picker. onSaved(prebuild) runs after the save and the
// popup closes; Cancel just closes it.
function openPrebuildForm({ onSaved, prebuild } = {}) {
  const overlay = openModal(`<div class="prebuild-form-root">${prebuildFormHtml({ heading: prebuild ? 'Edit prebuild' : 'New prebuild', inPopup: true })}</div>`, { maxWidth: 760, zIndex: 110 });
  const root = overlay.querySelector('.prebuild-form-root');
  const api = mountPrebuildForm(root, {
    onCancel: () => overlay.remove(),
    onSaved: async (saved) => {
      overlay.remove();
      if (onSaved) await onSaved(saved);
    },
  });
  if (prebuild) api.loadForEdit(prebuild);
  return overlay;
}
