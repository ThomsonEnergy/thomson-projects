// The Savings assumptions page of a quote (backlog item 72): one panel, opened from the bill card
// on step 1 (step 5 lists what is held back and links there), with two parts.
//   1. Every value the savings estimate assumes, with its normal value and a box to change it for
//      this quote only. Blank means the normal value.
//   2. Every hard block that is holding figures off the proposal (no bill read, no kWh, no rate,
//      no bill total, existing solar size unknown), each with "Show the figures anyway", the figure
//      to use in its place and a short reason.
// The proposal's "What we assumed" list always prints the value in use, and an overridden block in
// plain words, so the client sees what the figures rest on (solar-roi.js: roiSettings,
// roiApplyOverrides, roiBasisLists).
//
// Who calls it: project.html, wireBillCard. Writes: projects.roi_inputs (the `assumptions` and
// `overrides` keys only, the rest is left as saved) and one activity_log line saying who changed
// what and why. The keys and their limits are the ones roiSettings reads: change them together.

// The assumed values, in the order shown. `scale` turns the stored number into what a person types
// (0.7 clear days as "7", 0.9 round trip as "90"); `normal` reads the normal value from roiSettings.
const SAVINGS_FIELDS = [
  { key: 'yield_per_kw', label: 'Sun: kWh a day from each kW of panels, averaged over the year', min: 1, max: 7, step: 0.1, scale: 1, normal: (n) => n.yieldPerKw, hint: 'The normal value is for this quote\'s STC zone.' },
  { key: 'clear_day_share', label: 'Clear days in every 10 (the rest are overcast)', min: 3, max: 10, step: 1, scale: 10, normal: (n) => n.clearShare },
  { key: 'overcast_output', label: 'What an overcast day makes, % of a normal day', min: 0, max: 90, step: 5, scale: 100, normal: (n) => n.overcastGen },
  { key: 'daylight_share', label: 'Power used between 6am and 6pm, % of the day\'s use', min: 10, max: 90, step: 1, scale: 100, normalText: 'about 51 (a typical home)', hint: 'Not used when the bill splits peak, shoulder and off-peak kWh: the bill decides then.' },
  { key: 'annual_kwh', label: 'Power the home uses in a year, kWh', min: 100, max: 5000000, step: 1, scale: 1, normalText: 'from the bill', hint: 'Only when the bill\'s period is not typical of the year.' },
  { key: 'battery_round_trip', label: 'Battery gives back, % of the power put into it', min: 50, max: 100, step: 1, scale: 100, normal: (n) => n.batteryRoundTrip },
  { key: 'battery_charge_rate', label: 'Battery charges or discharges in an hour, % of its size', min: 10, max: 200, step: 5, scale: 100, normal: (n) => n.batteryMaxChargeC },
  { key: 'battery_life_years', label: 'Years the battery\'s saving is counted for', min: 1, max: 25, step: 1, scale: 1, whole: true, normal: (n) => n.batteryLifeYears },
  { key: 'price_rise', label: 'Power prices rise a year, % (for the "if prices rise" figures)', min: 0, max: 15, step: 0.5, scale: 100, normal: (n) => n.priceRise },
  { key: 'panel_loss', label: 'Panels make less each year, %', min: 0, max: 5, step: 0.1, scale: 100, normal: (n) => n.panelLoss },
  { key: 'grid_emissions', label: 'Grid emissions, kg of CO2 for each kWh', min: 0, max: 2, step: 0.01, scale: 1, normal: (n) => n.emissions },
];
// The four seasons, against the yearly average: what the panels make and what the home uses.
const SAVINGS_SEASONS = ['Summer', 'Autumn', 'Winter', 'Spring'].flatMap((name, i) => [
  { key: `season_gen_${i}`, label: `${name}: panels make, % of the yearly average`, min: 20, max: 200, step: 5, scale: 100, normal: (n) => n.seasons[i].gen },
  { key: `season_load_${i}`, label: `${name}: the home uses, % of the yearly average`, min: 20, max: 200, step: 5, scale: 100, normal: (n) => n.seasons[i].load },
]);

// The hard blocks that can be shown anyway, and the figure each needs in the missing one's place.
// `required` fields must be filled for the override to do anything (roiApplyOverrides).
const SAVINGS_BLOCKS = {
  bill: { title: 'No electricity bill read', fields: [{ key: 'daily_kwh', label: 'Use, kWh a day', required: true }, { key: 'rate_c', label: 'Rate, c/kWh', required: true }, { key: 'supply_c', label: 'Supply charge, c a day' }, { key: 'feed_in_c', label: 'Feed-in, c/kWh' }] },
  usage: { title: 'No kWh on the bill', fields: [{ key: 'daily_kwh', label: 'Use, kWh a day', required: true }] },
  rate: { title: 'No rate on the bill', fields: [{ key: 'rate_c', label: 'Rate, c/kWh', required: true }] },
  total: { title: 'No bill total', fields: [], note: 'The bills now and after are then worked out from the rates and the use.' },
  existing: { title: 'Existing solar size not known', fields: [{ key: 'kw', label: 'Existing solar, kW (blank or 0 leaves it out)' }] },
};

// Opens the panel. gaps: the estimate's gaps as last worked out (roiPresentation().gaps), so the
// blocks listed are the ones on now. onSaved(roiInputs) gets the quote's saved inputs back.
async function openSavingsAssumptions({ project, gaps, zoneRating, onSaved }) {
  const saved = project.roi_inputs || {};
  const typed = (saved.assumptions && typeof saved.assumptions === 'object') ? saved.assumptions : {};
  const overrides = (saved.overrides && typeof saved.overrides === 'object') ? saved.overrides : {};
  const normal = roiSettings({}, zoneRating);
  const show = (f, stored) => { const n = Number(stored); return Number.isFinite(n) ? String(Math.round(n * f.scale * 1000) / 1000) : ''; };
  const fieldRow = (f) => {
    const normalText = f.normalText || show(f, f.normal(normal));
    return `<div style="display:grid; grid-template-columns:1fr 110px; gap:4px 12px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
      <div><div style="font-size:13px;">${escapeHtml(f.label)}</div><div class="subtitle" style="font-size:11.5px; margin:1px 0 0;">Normal: ${escapeHtml(normalText)}${f.hint ? `. ${escapeHtml(f.hint)}` : ''}</div></div>
      <input type="number" inputmode="decimal" class="sa-field" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" placeholder="${escapeHtml(f.normalText ? 'normal' : normalText)}" value="${escapeHtml(typed[f.key] != null ? show(f, typed[f.key]) : '')}" style="margin:0;" />
    </div>`;
  };
  // the blocks on now (holding figures back, or already shown anyway), plus any override still saved
  const blockKeys = [...new Set([...(gaps || []).filter(g => (g.blocking || g.overridden) && SAVINGS_BLOCKS[g.key]).map(g => g.key), ...Object.keys(overrides).filter(k => overrides[k] && overrides[k].on && SAVINGS_BLOCKS[k])])];
  const fixElsewhere = (gaps || []).filter(g => g.blocking && !SAVINGS_BLOCKS[g.key]);
  const blockHtml = (key) => {
    const b = SAVINGS_BLOCKS[key], o = overrides[key] || {};
    const gap = (gaps || []).find(g => g.key === key);
    return `<div class="sa-block" data-key="${key}" style="padding:10px 12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
      <label style="display:flex; align-items:center; gap:8px; margin:0; font-weight:600;"><input type="checkbox" class="sa-on" style="width:auto; margin:0;" ${o.on ? 'checked' : ''} /> ${escapeHtml(b.title)}: show the figures anyway</label>
      <p class="subtitle" style="margin:4px 0 6px; font-size:12px;">${escapeHtml(gap ? gap.staff : 'Not holding anything back right now.')}${b.note ? ` ${escapeHtml(b.note)}` : ''}</p>
      <div class="sa-detail" style="${o.on ? '' : 'display:none;'}">
        ${b.fields.length ? `<div class="grid cols-2" style="gap:8px 12px;">${b.fields.map(f => `<div><label style="margin-top:0; font-size:12px;">${escapeHtml(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label><input type="number" inputmode="decimal" min="0" step="any" class="sa-value" data-field="${f.key}" value="${escapeHtml((o.values || {})[f.key] != null ? String((o.values || {})[f.key]) : '')}" style="margin:0;" /></div>`).join('')}</div>` : ''}
        <label style="font-size:12px;">Why <span class="req" aria-hidden="true">*</span></label>
        <input type="text" class="sa-reason" maxlength="200" placeholder="e.g. Client is sending the bill next week" value="${escapeHtml(o.reason || '')}" style="margin:0;" />
        ${o.by ? `<p class="subtitle" style="margin:4px 0 0; font-size:11.5px;">Set by ${escapeHtml(o.by)}${o.at ? ` on ${new Date(o.at).toLocaleDateString('en-AU')}` : ''}.</p>` : ''}
      </div>
    </div>`;
  };
  const quoteRef = project.quote_number ? `Q${project.quote_number}` : 'this quote';
  const overlay = openModal(`
      <h2 style="margin-bottom:4px;">Savings assumptions, ${escapeHtml(quoteRef)}</h2>
      <p class="subtitle" style="margin:0 0 12px;">The normal values suit most homes: change one only when you know better for this job, and leave a box blank for the normal value. The proposal's "What we assumed" list always shows the value in use.</p>
      <h3 style="font-size:14px; margin:0 0 2px;">Blocks holding figures off the proposal</h3>
      ${blockKeys.length ? blockKeys.map(blockHtml).join('') : '<p class="subtitle" style="margin:2px 0 10px; font-size:12.5px;">None: the figures are showing.</p>'}
      ${fixElsewhere.length ? `<p class="subtitle" style="margin:0 0 10px; font-size:12.5px;">Fixed on the quote itself, not here: ${fixElsewhere.map(g => escapeHtml(g.staff)).join(' ')}</p>` : ''}
      <h3 style="font-size:14px; margin:14px 0 2px;">Assumed values</h3>
      ${SAVINGS_FIELDS.map(fieldRow).join('')}
      <details style="margin-top:8px;"><summary style="cursor:pointer; font-size:13px;">Seasons</summary>${SAVINGS_SEASONS.map(fieldRow).join('')}</details>
      <p class="subtitle" style="margin:10px 0 0; font-size:12px;">Changed where it lives, not here: the export limit and the existing system (step 1), the bill's own figures and the rates (the bill card), the battery size and the prices (What we are quoting).</p>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;"><button type="button" id="sa-save">Save</button> <button type="button" class="secondary" id="sa-reset">Back to the normal values</button> <button type="button" class="secondary" id="sa-cancel">Cancel</button></div>
      <div id="sa-msg"></div>`, { maxWidth: 620, zIndex: 110 });
  const msg = overlay.querySelector('#sa-msg');
  overlay.querySelectorAll('.sa-on').forEach(cb => cb.addEventListener('change', () => { cb.closest('.sa-block').querySelector('.sa-detail').style.display = cb.checked ? '' : 'none'; }));
  overlay.querySelector('#sa-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#sa-reset').addEventListener('click', () => { overlay.querySelectorAll('.sa-field').forEach(el => { el.value = ''; }); msg.innerHTML = '<p class="subtitle" style="font-size:12px; margin-top:8px;">Every box is blank: press Save to go back to the normal values.</p>'; });

  overlay.querySelector('#sa-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#sa-save');
    msg.innerHTML = '';
    try {
      // the assumed values: blank is the normal value; anything typed must be inside its limits
      const assumptions = {};
      const changes = [];
      [...SAVINGS_FIELDS, ...SAVINGS_SEASONS].forEach(f => {
        const raw = overlay.querySelector(`.sa-field[data-key="${f.key}"]`).value.trim();
        if (raw === '') { if (typed[f.key] != null) changes.push(`${f.label}: back to normal`); return; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < f.min || n > f.max || (f.whole && !Number.isInteger(n))) throw new Error(`${f.label}: type a ${f.whole ? 'whole ' : ''}number from ${f.min} to ${f.max}, or leave it blank.`);
        assumptions[f.key] = Math.round(n / f.scale * 1e6) / 1e6;
        if (show(f, typed[f.key]) !== String(Math.round(n * 1000) / 1000)) changes.push(`${f.label}: ${n}`);
      });
      // the blocks shown anyway: each needs its figure and a reason
      const profile = typeof getMyProfile === 'function' ? await getMyProfile() : null;
      const by = (profile && (profile.full_name || profile.email)) || 'staff';
      const newOverrides = {};
      overlay.querySelectorAll('.sa-block').forEach(el => {
        const key = el.dataset.key, b = SAVINGS_BLOCKS[key], was = overrides[key] || {};
        if (!el.querySelector('.sa-on').checked) { if (was.on) changes.push(`${b.title}: no longer shown anyway`); return; }
        const values = {};
        b.fields.forEach(f => {
          const raw = el.querySelector(`.sa-value[data-field="${f.key}"]`).value.trim();
          const n = raw === '' ? null : Number(raw);
          if (f.required && !(n > 0)) throw new Error(`${b.title}: fill in "${f.label}".`);
          if (n != null && (!Number.isFinite(n) || n < 0)) throw new Error(`${b.title}: "${f.label}" cannot be below zero.`);
          if (n != null) values[f.key] = n;
        });
        const reason = el.querySelector('.sa-reason').value.trim();
        if (reason.length < 3) throw new Error(`${b.title}: say why the figures are shown anyway.`);
        const same = was.on && was.reason === reason && JSON.stringify(was.values || {}) === JSON.stringify(values);
        newOverrides[key] = same ? was : { on: true, values, reason, by, at: new Date().toISOString() };
        if (!same) changes.push(`${b.title}: shown anyway (${reason})`);
      });
      if (!changes.length) { overlay.remove(); return; }
      btn.disabled = true; btn.textContent = 'Saving...';
      // only these two keys change; everything else on roi_inputs is written back as it was read
      const { data: fresh, error: readErr } = await supabaseClient.from('projects').select('roi_inputs').eq('id', project.id).single();
      if (readErr) throw readErr;
      const roiInputs = { ...((fresh && fresh.roi_inputs) || {}), assumptions, overrides: newOverrides };
      const { error } = await supabaseClient.from('projects').update({ roi_inputs: roiInputs }).eq('id', project.id);
      if (error) throw error;
      await logActivity('project', project.id, 'savings_assumptions', `Savings assumptions changed: ${changes.join('; ')}`.slice(0, 900));
      overlay.remove();
      showToast('Savings assumptions saved.');
      if (onSaved) onSaved(roiInputs);
    } catch (err) {
      msg.innerHTML = `<div class="error-box" style="margin-top:8px;">${escapeHtml(friendlyError(err))}</div>`;
      btn.disabled = false; btn.textContent = 'Save';
    }
  });
}
