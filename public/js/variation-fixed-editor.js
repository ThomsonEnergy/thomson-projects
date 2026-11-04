// The fixed-price variation editor (backlog item 43, docs/PROJECT_SPEC.md "Variations"): pricing roles
// set up, or rewrite the draft of, a fixed-price variation: the reason the client will read and the
// priced lines, priced the way a quote stage is. A Labour line picks a rate tier from the Schedule of
// Rates (billable_rate_tiers) and hours (a typed rate when no tier fits); a Materials line is quantity
// x cost price, marked up by the variation's one Markup box (default from Settings > Company).
// "+ From Stock or prebuild" adds Stock at its cost price and a prebuild's components grouped under
// the prebuild's name, which the client's document shows as one line. Saving keeps it a draft and goes
// through /.netlify/functions/create-variation, which prices every line again on the server.
// Downloaded by project.html the first time the editor is opened (openFixedVariationEditor there); needs supabase-client.js (supabaseClient, escapeHtml, money, friendlyError,
// getPrebuilds, logActivity) and the page's openVariationStockPicker and markupOr45.
(function () {
  const esc = (s) => escapeHtml(s);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  // A line's sell amount, the same sum the server does (_shared/fixed-variation-lines.js).
  function lineAmount(l, markup) {
    const qty = num(l.quantity), rate = num(l.unit_cost);
    return l.item_type === 'labour' ? r2(qty * rate) : r2(qty * rate * (1 + markup / 100));
  }

  // Lines saved before 4 Nov 2026 have only { description, item_type, amount }: the amount is the sell
  // price. Loaded as quantity 1 at that price (materials taken back to cost so the markup box leaves
  // the total as it was).
  function loadLine(l, markup) {
    if (l.quantity != null) return { ...l };
    const amount = num(l.amount);
    return {
      description: l.description || '', item_type: l.item_type === 'labour' ? 'labour' : 'material', quantity: 1,
      unit_cost: l.item_type === 'labour' ? amount : r2(amount / (1 + markup / 100)), rate_tier_id: null,
      prebuild_group_id: null, prebuild_client_description: null,
    };
  }

  const blankLine = () => ({ description: '', item_type: 'labour', quantity: '', unit_cost: '', rate_tier_id: '', prebuild_group_id: null, prebuild_client_description: null });

  async function openFixedVariationEditor(project, entry, onSaved) {
    const [{ data: tiers }, { data: cs }, cards] = await Promise.all([
      supabaseClient.from('billable_rate_tiers').select('id, name, sell_rate').order('sort_order'),
      supabaseClient.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle(),
      loadRateCards(),
    ]);
    const TIERS = tiersAtCard(tiers || [], rateCardOf(project, cards));  // at the job's charge rate level (item 46)
    const tierById = (id) => TIERS.find(t => t.id === id);
    const saved = entry && entry.fixed_lines && entry.fixed_lines.length ? entry.fixed_lines : [];
    const savedMarkup = saved.find(l => l.item_type !== 'labour' && l.markup_percent != null);
    let markup = savedMarkup ? num(savedMarkup.markup_percent) : markupOr45(cs?.default_markup_percent);
    const lines = saved.length ? saved.map(l => loadLine(l, markup)) : [blankLine()];

    // The figures row of each line: four across on a desktop, two by two on a phone.
    if (!document.getElementById('fv-style')) {
      const st = document.createElement('style');
      st.id = 'fv-style';
      st.textContent = '.fv-row2{display:grid;grid-template-columns:90px minmax(0,1fr) 100px 90px;gap:6px;margin-bottom:10px;align-items:center}.fv-row2 .fv-l-amt{text-align:right;font-weight:600;font-size:13px;white-space:nowrap}@media(max-width:600px){.fv-row2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}';
      document.head.appendChild(st);
    }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:110; padding:16px;';
    overlay.innerHTML = `
      <div class="card" style="max-width:680px; width:100%; max-height:90vh; overflow-y:auto;">
        <h2>${entry ? 'Edit fixed-price variation' : 'New fixed-price variation'}</h2>
        <p class="subtitle" style="margin-bottom:10px;">The client gets this as its own variation document (referencing their original quote), then signs to approve it. Once signed it's added to the job as a stage at this price.</p>
        <label style="margin-top:0;">What is the extra work?</label>
        <input id="fv-desc" value="${esc(entry ? entry.description : '')}" placeholder="e.g. Move meter box and run new sub-main" />
        <label>Reason for the variation (the client reads this)</label>
        <textarea id="fv-reason" style="min-height:80px;" placeholder="e.g. The builder moved the meter location after the quote was accepted, which needs a longer cable run.">${esc(entry ? entry.reason || '' : '')}</textarea>
        <div style="display:flex; align-items:end; gap:12px; flex-wrap:wrap; margin-top:12px;">
          <div style="flex:1;"><label style="margin-top:0;">Priced lines (ex GST)</label><p class="subtitle" style="margin:0; font-size:12px;">Labour at the Schedule of Rates, materials at cost plus markup, like a quote stage.</p></div>
          <div><label style="margin-top:0;">Markup on materials %</label><input id="fv-markup" type="number" min="0" step="0.1" inputmode="decimal" value="${markup}" style="width:110px; margin:0;" /></div>
        </div>
        <div id="fv-lines" style="margin-top:8px;"></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
          <button type="button" class="secondary" id="fv-add-line" style="font-size:12px; padding:6px 10px;">+ Add a line</button>
          <button type="button" class="secondary" id="fv-add-stock" style="font-size:12px; padding:6px 10px;">+ From Stock or prebuild</button>
        </div>
        <p style="margin:12px 0 0; font-size:14px;">Total: <strong id="fv-total">$0.00</strong> ex GST <span class="subtitle" id="fv-total-gst"></span></p>
        <div id="fv-msg"></div>
        <div style="margin-top:12px;"><button type="button" id="fv-save">Save draft</button> <button type="button" class="secondary" id="fv-cancel">Cancel</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const linesEl = $('#fv-lines');
    const sum = () => lines.reduce((s, l) => s + lineAmount(l, markup), 0);
    const refreshTotal = () => {
      $('#fv-total').textContent = money(sum());
      $('#fv-total-gst').textContent = `(${money(sum() * 1.1)} inc GST)`;
      lines.forEach((l, i) => { const el = linesEl.querySelector(`.fv-l-amt[data-i="${i}"]`); if (el) el.textContent = money(lineAmount(l, markup)); });
    };

    const tierOptions = (l) => `<option value="">Rate typed below</option>${TIERS.map(t => `<option value="${esc(t.id)}" ${l.rate_tier_id === t.id ? 'selected' : ''}>${esc(t.name)} (${money(t.sell_rate)}/hr)</option>`).join('')}`;
    const renderLines = () => {
      let lastGroup = null;
      linesEl.innerHTML = lines.map((l, i) => {
        const isLabour = l.item_type === 'labour';
        const groupHead = l.prebuild_group_id && l.prebuild_group_id !== lastGroup
          ? `<p class="subtitle" style="margin:8px 0 4px; font-size:12px;">Prebuild: <b>${esc(l.prebuild_client_description || '')}</b> (the client sees it as one line)</p>` : '';
        lastGroup = l.prebuild_group_id || null;
        return `${groupHead}
          <div style="display:grid; grid-template-columns:1fr 110px auto; gap:6px; margin-bottom:4px; align-items:center; ${l.prebuild_group_id ? 'padding-left:12px; border-left:2px solid var(--border);' : ''}">
            <input class="fv-l-desc" data-i="${i}" value="${esc(l.description)}" placeholder="${isLabour ? 'Optional - defaults to the rate tier name' : 'Description'}" style="margin:0;" />
            <select class="fv-l-type" data-i="${i}" style="margin:0;"><option value="labour" ${isLabour ? 'selected' : ''}>Labour</option><option value="material" ${!isLabour ? 'selected' : ''}>Materials</option></select>
            <button type="button" class="secondary fv-l-del" data-i="${i}" style="font-size:12px; padding:4px 9px;">&times;</button>
          </div>
          <div class="fv-row2" style="${l.prebuild_group_id ? 'padding-left:12px; border-left:2px solid var(--border);' : ''}">
            <input class="fv-l-qty" data-i="${i}" type="number" min="0" step="0.01" inputmode="decimal" value="${l.quantity === '' ? '' : num(l.quantity)}" placeholder="${isLabour ? 'Hours' : 'Qty'}" style="margin:0;" />
            ${isLabour ? `<select class="fv-l-tier" data-i="${i}" style="margin:0; min-width:0;">${tierOptions(l)}</select>` : `<span class="subtitle" style="font-size:12px;">at cost each + ${num(markup)}%</span>`}
            <input class="fv-l-cost" data-i="${i}" type="number" min="0" step="0.01" inputmode="decimal" value="${l.unit_cost === '' ? '' : num(l.unit_cost)}" placeholder="${isLabour ? '$/hr' : 'Cost $'}" style="margin:0;" ${isLabour && l.rate_tier_id ? 'readonly' : ''} />
            <span class="fv-l-amt" data-i="${i}"></span>
          </div>`;
      }).join('');
      linesEl.querySelectorAll('.fv-l-desc').forEach(el => el.addEventListener('input', () => { lines[el.dataset.i].description = el.value; }));
      linesEl.querySelectorAll('.fv-l-type').forEach(el => el.addEventListener('change', () => {
        const l = lines[el.dataset.i];
        l.item_type = el.value;
        if (l.item_type === 'material') l.rate_tier_id = '';
        renderLines(); refreshTotal();
      }));
      linesEl.querySelectorAll('.fv-l-qty').forEach(el => el.addEventListener('input', () => { lines[el.dataset.i].quantity = el.value; refreshTotal(); }));
      linesEl.querySelectorAll('.fv-l-cost').forEach(el => el.addEventListener('input', () => { lines[el.dataset.i].unit_cost = el.value; refreshTotal(); }));
      linesEl.querySelectorAll('.fv-l-tier').forEach(el => el.addEventListener('change', () => {
        const l = lines[el.dataset.i];
        const t = tierById(el.value);
        l.rate_tier_id = t ? t.id : '';
        if (t) l.unit_cost = num(t.sell_rate);
        renderLines(); refreshTotal();
      }));
      linesEl.querySelectorAll('.fv-l-del').forEach(el => el.addEventListener('click', () => { lines.splice(Number(el.dataset.i), 1); if (!lines.length) lines.push(blankLine()); renderLines(); refreshTotal(); }));
      refreshTotal();
    };
    renderLines();
    $('#fv-markup').addEventListener('input', () => { markup = Math.max(0, num($('#fv-markup').value)); renderLines(); });
    $('#fv-add-line').addEventListener('click', () => { lines.push(blankLine()); renderLines(); });

    // Priced like a quote stage: Stock at its cost price (the markup box marks it up), a prebuild's
    // components one line each (its labour at the prebuild's own rate, its materials at cost), grouped
    // so the client sees the prebuild's one line. Price only, nothing leaves Stock.
    $('#fv-add-stock').addEventListener('click', async () => {
      const pick = await openVariationStockPicker(true, true); // price only: no low-stock warning
      if (!pick) return;
      const qty = num(pick.quantity) || 1;
      const added = [];
      if (pick.kind === 'material') {
        const { data: m } = await supabaseClient.from('materials').select('cost_price').eq('id', pick.id).maybeSingle();
        added.push({ description: pick.name, item_type: 'material', quantity: qty, unit_cost: r2(m?.cost_price), rate_tier_id: '', prebuild_group_id: null, prebuild_client_description: null });
      } else {
        const pb = (await getPrebuilds()).find(p => p.id === pick.id);
        const comps = ((pb && pb.prebuild_components) || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const groupId = crypto.randomUUID();
        const clientDescription = (pb && (pb.client_description || pb.name)) || pick.name;
        comps.forEach(c => added.push({
          description: `${pick.name} - ${c.description}`, item_type: c.item_type === 'labour' ? 'labour' : 'material',
          quantity: r2(num(c.quantity) * qty), unit_cost: r2(c.unit_cost), rate_tier_id: '',
          prebuild_group_id: groupId, prebuild_client_description: clientDescription,
        }));
        if (!added.length) added.push({ description: pick.name, item_type: 'material', quantity: qty, unit_cost: '', rate_tier_id: '', prebuild_group_id: null, prebuild_client_description: null });
      }
      // fill the blank starting line rather than leaving it empty above
      if (lines.length === 1 && !lines[0].description && !(num(lines[0].quantity) > 0)) lines.splice(0, 1);
      lines.push(...added);
      renderLines();
    });
    $('#fv-cancel').addEventListener('click', () => overlay.remove());
    $('#fv-save').addEventListener('click', async () => {
      const msg = $('#fv-msg');
      const description = $('#fv-desc').value.trim();
      const reason = $('#fv-reason').value.trim();
      const clean = lines.map(l => ({
        description: String(l.description || '').trim() || (l.item_type === 'labour' && tierById(l.rate_tier_id) ? tierById(l.rate_tier_id).name : ''),
        item_type: l.item_type === 'labour' ? 'labour' : 'material', quantity: num(l.quantity), unit_cost: num(l.unit_cost),
        rate_tier_id: l.rate_tier_id || null, prebuild_group_id: l.prebuild_group_id || null, prebuild_client_description: l.prebuild_client_description || null,
      })).filter(l => l.description && l.quantity > 0);
      if (!description) { msg.innerHTML = `<div class="error-box">Say what the extra work is.</div>`; return; }
      if (!reason) { msg.innerHTML = `<div class="error-box">Add the reason, so the client knows why.</div>`; return; }
      if (!clean.length) { msg.innerHTML = `<div class="error-box">Add at least one priced line: a description and hours or a quantity.</div>`; return; }
      if (clean.some(l => !(l.unit_cost > 0))) { msg.innerHTML = `<div class="error-box">Every line needs a rate tier or rate (labour) or a cost each (materials).</div>`; return; }
      const saveBtn = $('#fv-save');
      saveBtn.disabled = true;
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const res = await fetch('/.netlify/functions/create-variation', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ projectId: project.id, entryId: entry ? entry.id : null, type: 'fixed', description, reason, lines: clean, markupPercent: markup }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) throw new Error(d.error || 'Could not save it');
        if (!entry) await logActivity('project', project.id, 'variation_logged', `Fixed-price variation ${d.number} drafted: ${description}`);
        overlay.remove();
        await onSaved();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`;
        saveBtn.disabled = false;
      }
    });
  }

  window.openFixedVariationEditorPanel = openFixedVariationEditor;
})();
