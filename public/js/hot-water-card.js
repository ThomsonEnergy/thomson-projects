// The Hot Water quote's own pieces on the quote page (item 113). Loaded by project.html for a quote
// of type hot_water (pricing roles):  mountHotWater({ project })
//
//  1. The hot water card on step 1, under the questions: the unit (a prebuild marked as a hot water
//     unit), the few figures off the bill, how it will be run, and the saving worked out from them
//     (js/hot-water.js). Saved to projects.hot_water as typed, with the result, so the client's
//     proposal prints what is on this screen.
//  2. The credits card on step 3: the STC count comes from the unit, the battery block is hidden,
//     and the other rebates that fit this quote's type and state (Settings > Rebates) are listed,
//     ticked the first time. Ticked rebates are saved to projects.rebates and rebates_total, and
//     the box "STC total" becomes STCs plus rebates: that one figure is what comes off the
//     client's invoice (projects.stc_total), so invoices and Xero need nothing new.
//
// Reads prebuilds, rebates. Writes projects.hot_water, projects.rebates, projects.rebates_total.
// Needs supabase-client.js (supabaseClient, escapeHtml, money, friendlyError), hot-water.js.

const HW_RUN_HELP = 'Pick how the unit will be set up on this job; the proposal marks that row.';

// The state the work is in, for which rebates fit: from the saved address, else from its text.
function hwSiteState(project) {
  const parts = project.address_parts || {};
  if (parts.state) return String(parts.state).toUpperCase();
  const m = /\b(NSW|QLD|VIC|ACT|SA|WA|TAS|NT)\b/i.exec(project.client_address || '');
  return m ? m[1].toUpperCase() : '';
}

// Starting figures from the bill reading, when a bill has been read on this quote.
function hwFromBill(reading) {
  const r = reading || {};
  const rates = r.usage_rates || {};
  const days = Number(r.billing_days) || 0;
  const round = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : '');
  return {
    generalRate: round(Number(r.usage_rate_c_per_kwh) || Number(rates.peak)),
    controlledRate: round(Number(rates.controlled_load)),
    feedInRate: round(Number(r.feed_in_c_per_kwh)),
    spareSolarKwhPerDay: days ? round(Number(r.solar_export_kwh) / days) : '',
  };
}

async function mountHotWater({ project }) {
  const questions = document.getElementById('template-questions');
  const credits = document.getElementById('credits-card');
  if (!questions || !credits || document.getElementById('hw-card')) return;
  const state = project.hot_water || {};
  const inputs = { ...hwFromBill(project.bill_reading), dayPlanRate: '', gasRate: '', ...(state.inputs || {}) };
  let unit = state.unit || null;
  let chosen = state.chosen || '';
  let show = state.show !== false;
  let rebatesSeen = !!state.rebates_seen;
  await loadJsOnce('/js/hot-water.js?v=1', () => typeof hwEstimate === 'function');

  const [{ data: units }, { data: rebateRows, error: rebatesErr }] = await Promise.all([
    supabaseClient.from('prebuilds').select('id, name, hw_kind, hw_litres, hw_cop, stc_count').not('hw_kind', 'is', null).order('name'),
    supabaseClient.from('rebates').select('*').eq('active', true).order('sort_order'),
  ]);
  // the page may have been drawn again while those loaded: this copy of the quote is gone
  if (!questions.isConnected || document.getElementById('hw-card')) return;
  const answer = (qid) => { const el = document.querySelector(`.tq-input[data-qid="${qid}"]`); return el ? el.value : (project.template_answers || {})[qid] || ''; };
  const quoteTotal = () => (project.cost_centres || []).reduce((sum, c) => sum + Number(c.quoted_amount || 0), 0) * 1.1;
  const num = (id) => { const v = parseFloat((document.getElementById(id) || {}).value); return Number.isFinite(v) ? v : 0; };

  // ---------------------------------------------------------------- 1. the card on step 1
  const card = document.createElement('div');
  card.id = 'hw-card';
  card.style.cssText = 'margin-top:14px; padding:12px; background:var(--surface-2); border-radius:8px;';
  const box = (key, label, placeholder) => `<div><label style="margin-top:0; font-size:12px;">${label}</label><input class="hw-in" data-key="${key}" type="number" step="0.1" min="0" value="${escapeHtml(inputs[key] ?? '')}" placeholder="${placeholder}" /></div>`;
  card.innerHTML = `
    <label style="margin-top:0; font-weight:600;">Hot water unit and saving</label>
    <p class="subtitle" style="margin:2px 0 10px; font-size:12px;">The heater there now and the people in the home come from the questions above. Type the rates off their power bill${project.bill_reading ? ' (filled from the bill already read on this quote)' : ''}.</p>
    <div class="grid cols-4">
      <div style="grid-column: span 2;"><label style="margin-top:0; font-size:12px;">The unit quoted</label>
        <select id="hw-unit"><option value="">Pick the unit</option>${(units || []).map((u) => `<option value="${u.id}" ${unit && unit.prebuild_id === u.id ? 'selected' : ''}>${escapeHtml(u.name)}${u.hw_litres ? `, ${u.hw_litres} L` : ''}${u.stc_count ? `, ${u.stc_count} STCs` : ''}</option>`).join('')}</select></div>
      <div><label style="margin-top:0; font-size:12px;">How many</label><input id="hw-qty" type="number" step="1" min="1" value="${(unit && unit.qty) || 1}" /></div>
      <div><label style="margin-top:0; font-size:12px;">How it will run</label><select id="hw-chosen" title="${HW_RUN_HELP}"></select></div>
    </div>
    ${(units || []).length ? '' : '<p class="subtitle" style="margin:6px 0 0; font-size:12px;">No hot water units in the library yet. Add one under Prebuilds: category Electrical, subcategory Hot water, and fill in its litres, efficiency and STCs.</p>'}
    <div class="grid cols-4" style="margin-top:6px;">
      ${box('generalRate', 'Normal rate (c a kWh)', 'e.g. 32')}
      ${box('controlledRate', 'Controlled load rate (c a kWh)', 'blank if none')}
      ${box('spareSolarKwhPerDay', 'Solar sent to the grid (kWh a day)', 'blank if no solar')}
      ${box('feedInRate', 'Paid for it (c a kWh)', 'e.g. 5')}
    </div>
    <div class="grid cols-4" style="margin-top:6px;">
      ${box('dayPlanRate', 'Daytime plan rate (c a kWh)', '0 for free power, blank to leave out')}
      <div id="hw-gas-box">${box('gasRate', 'Gas price (c a MJ)', 'blank for the usual figure')}</div>
      <label style="grid-column: span 2; display:flex; align-items:center; gap:6px; font-weight:400; margin:18px 0 0;"><input type="checkbox" id="hw-show" style="width:auto;" ${show ? 'checked' : ''} /> Show the saving on the proposal</label>
    </div>
    <div id="hw-preview" style="margin-top:10px;"></div>
    <div id="hw-msg"></div>`;
  questions.insertAdjacentElement('afterend', card);

  // The unit, the typed figures and the saving save here, a moment after the last change and only
  // when something is different (opening the quote writes nothing). The rebates do not: they are
  // money, so they save with the STC total in the quote's own autosave (window.hwCredits below).
  let saveTimer = null;
  const snapshot = () => JSON.stringify({ hot_water: project.hot_water || null });
  let savedSnapshot = snapshot();
  const saveSoon = (fields) => {
    Object.assign(project, fields);
    clearTimeout(saveTimer);
    if (snapshot() === savedSnapshot) return;
    saveTimer = setTimeout(async () => {
      const sending = snapshot();
      const { error } = await supabaseClient.from('projects').update(JSON.parse(sending)).eq('id', project.id);
      if (!error) savedSnapshot = sending;
      card.querySelector('#hw-msg').innerHTML = error ? `<div class="error-box">Not saved. ${escapeHtml(friendlyError(error))}</div>` : '';
    }, 600);
  };

  function redraw() {
    card.querySelectorAll('.hw-in').forEach((el) => { inputs[el.dataset.key] = el.value; });
    inputs.old = answer('hw_old');
    inputs.people = answer('hw_people');
    card.querySelector('#hw-gas-box').style.visibility = /^Gas/.test(inputs.old) ? '' : 'hidden';
    const net = Math.max(0, quoteTotal() - num('q-stc-total'));
    const est = unit ? hwEstimate(inputs, unit, net) : null;
    const pick = card.querySelector('#hw-chosen');
    if (est && !est.rows.some((r) => r.key === chosen)) chosen = est.best ? est.best.key : '';
    pick.innerHTML = est ? est.rows.map((r) => `<option value="${r.key}" ${r.key === chosen ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('') : '<option value="">Pick the unit first</option>';
    card.querySelector('#hw-preview').innerHTML = !unit ? ''
      : !est.rows.length ? '<p class="subtitle" style="margin:0;">Type the normal rate off their bill to see the saving.</p>'
        : `${hwTableHtml(est, chosen, escapeHtml)}<details style="margin-top:6px;"><summary class="subtitle" style="font-size:12px; cursor:pointer;">How this is worked out</summary><ul style="font-size:12px; margin:4px 0 0 16px;">${est.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul></details>`;
    saveSoon({ hot_water: { unit, inputs: { ...inputs }, chosen, show, rebates_seen: rebatesSeen, estimate: est ? { oldPerYear: est.oldPerYear, rows: est.rows, assumptions: est.assumptions } : null } });
  }

  card.querySelector('#hw-unit').addEventListener('change', (e) => {
    const u = (units || []).find((x) => x.id === e.target.value);
    const qty = Math.max(1, parseInt(card.querySelector('#hw-qty').value, 10) || 1);
    unit = u ? { prebuild_id: u.id, name: u.name, kind: u.hw_kind, litres: u.hw_litres, cop: u.hw_cop, stc_count: u.stc_count, qty } : null;
    setStcFromUnit();
    redraw();
  });
  card.querySelector('#hw-qty').addEventListener('change', (e) => {
    if (unit) { unit.qty = Math.max(1, parseInt(e.target.value, 10) || 1); setStcFromUnit(); }
    redraw();
  });
  card.querySelector('#hw-chosen').addEventListener('change', (e) => { chosen = e.target.value; redraw(); });
  card.querySelector('#hw-show').addEventListener('change', (e) => { show = e.target.checked; redraw(); });
  card.querySelectorAll('.hw-in').forEach((el) => el.addEventListener('change', redraw));
  // the heater there now and the people count are step 1 answers: follow them as they change
  questions.addEventListener('change', (e) => { if (e.target.closest('.tq-input[data-qid^="hw_"]')) redraw(); });

  // ---------------------------------------------------------------- 2. the credits card on step 3
  credits.style.display = '';
  const bstc = document.getElementById('bstc-credit-block');
  if (bstc) bstc.style.display = 'none';
  ['q-stc-kw', 'q-stc-zone', 'q-stc-year'].forEach((id) => { const el = document.getElementById(id); if (el && el.parentElement) el.parentElement.style.display = 'none'; });
  const stcBlock = document.getElementById('stc-credit-block');
  if (stcBlock) {
    stcBlock.querySelector('label').textContent = 'STC credit (hot water)';
    const hint = stcBlock.querySelector('p.subtitle');
    if (hint) hint.textContent = 'The number of STCs comes from the unit picked on step 1 (its count times how many). A typed count wins. "STC total" below is the STCs plus the ticked rebates: the one figure that comes off the invoice.';
  }

  function setStcFromUnit() {
    const qtyEl = document.getElementById('q-stc-qty');
    if (!qtyEl || !unit || !unit.stc_count) return;
    qtyEl.value = unit.stc_count * (unit.qty || 1);
    qtyEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const siteState = hwSiteState(project);
  // A rebate tied to a state is offered only when the site is known to be in it.
  const fits = (r) => (!r.state || (!!siteState && r.state.toUpperCase() === siteState)) && (!(r.proposal_types || []).length || r.proposal_types.includes('hot_water'));
  const offered = rebatesErr ? [] : (rebateRows || []).filter(fits);
  const saved = Array.isArray(project.rebates) ? project.rebates : [];
  // Rows: what this quote already has ticked (kept at its own figures even when the rebate has since
  // been switched off or changed in Settings), then whatever else is on offer.
  const rows = [
    ...saved.map((r) => ({ id: r.rebate_id, label: r.label, stc_type: r.stc_type || null, certs: r.certificates != null, certificates: r.certificates, price: r.price, amount: r.amount, on: true })),
    ...offered.filter((r) => !saved.some((x) => x.rebate_id === r.id)).map((r) => ({ id: r.id, label: r.client_label, stc_type: r.stc_type || null, certs: r.kind === 'certificates', certificates: r.certificates, price: r.certificate_price, amount: r.amount, on: false })),
  ];
  // The first time a quote sees rebates on offer they start ticked, and that is saved.
  const firstTime = !saved.length && !rebatesSeen && offered.length > 0;
  if (firstTime) rows.forEach((r) => { r.on = true; });

  const rebateBox = document.createElement('div');
  rebateBox.id = 'hw-rebates';
  rebateBox.style.cssText = 'margin-top:14px; padding-top:12px; border-top:0.5px solid var(--border);';
  const rowHtml = (r, i) => `<div class="hw-rebate" data-i="${i}" style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:6px;">
      <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400; flex:1 1 200px;"><input type="checkbox" class="hw-rb-on" style="width:auto;" ${r.on ? 'checked' : ''} /> ${escapeHtml(r.label)}</label>
      ${r.certs
        ? `<input class="hw-rb-count" type="number" step="1" min="0" value="${escapeHtml(r.certificates ?? '')}" title="Certificates" style="width:90px;" /> <span class="subtitle">x $</span> <input class="hw-rb-price" type="number" step="0.01" min="0" value="${escapeHtml(r.price ?? '')}" title="$ per certificate" style="width:90px;" />`
        : `<span class="subtitle">$</span> <input class="hw-rb-amount" type="number" step="0.01" min="0" value="${escapeHtml(r.amount ?? '')}" style="width:110px;" />`}
      <strong class="hw-rb-total" style="min-width:80px; text-align:right;"></strong>
    </div>`;
  rebateBox.innerHTML = `
    <label style="margin-top:0;">Other rebates${siteState ? ` (${escapeHtml(siteState)})` : ''}</label>
    ${rebatesErr ? `<div class="error-box">The rebates did not load, so nothing here was changed. Refresh the page. ${escapeHtml(friendlyError(rebatesErr))}</div>` : ''}
    ${rows.length ? `<p class="subtitle" style="margin:2px 0 6px; font-size:12px;">From Settings &gt; Rebates. Each ticked one prints on the proposal on its own line and comes off the client's price with the STCs.</p>${rows.map(rowHtml).join('')}`
      : rebatesErr ? '' : `<p class="subtitle" style="margin:2px 0 0; font-size:12px;">None on offer for this quote${siteState ? ' in ' + escapeHtml(siteState) : ' (the site address has no state on it yet)'}. They are set up under Settings &gt; Rebates.</p>`}`;
  credits.appendChild(rebateBox);
  const qtyEl = document.getElementById('q-stc-qty'), priceEl = document.getElementById('q-stc-price');
  const totalEl = document.getElementById('q-stc-total'), calcEl = document.getElementById('q-stc-calc');
  const boxNum = (el) => { const v = parseFloat(el && el.value); return Number.isFinite(v) ? v : 0; };

  // What is ticked on screen now, as it is saved: [{ rebate_id, label, stc_type, certificates, price, amount }].
  function pickedRebates() {
    const picked = [];
    rebateBox.querySelectorAll('.hw-rebate').forEach((rowEl) => {
      const r = rows[Number(rowEl.dataset.i)];
      const val = (cls) => parseFloat((rowEl.querySelector(cls) || {}).value) || 0;
      const amount = Math.round((r.certs ? val('.hw-rb-count') * val('.hw-rb-price') : val('.hw-rb-amount')) * 100) / 100;
      const on = rowEl.querySelector('.hw-rb-on').checked;
      rowEl.querySelector('.hw-rb-total').textContent = on && amount ? money(amount) : '';
      if (on && amount > 0) picked.push({ rebate_id: r.id, label: r.label, stc_type: r.stc_type, certificates: r.certs ? val('.hw-rb-count') : null, price: r.certs ? val('.hw-rb-price') : null, amount });
    });
    return picked;
  }
  const totalOf = (picked) => Math.round(picked.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;

  // STC total = STCs x price + ticked rebates. write: put the figure in the box (a change made
  // here, or the first time rebates are offered); otherwise only the working line is redrawn, so
  // opening a quote never changes its money.
  function sumCredits(write) {
    const rebatesTotal = totalOf(pickedRebates());
    const stcs = boxNum(qtyEl) * boxNum(priceEl);
    if (calcEl) calcEl.textContent = `= ${boxNum(qtyEl)} STCs x ${money(boxNum(priceEl))}${rebatesTotal ? ` + ${money(rebatesTotal)} of rebates` : ''} = ${money(stcs + rebatesTotal)}`;
    if (write && totalEl) {
      const combined = stcs + rebatesTotal > 0 ? (stcs + rebatesTotal).toFixed(2) : '';
      if (totalEl.value !== combined) {
        totalEl.value = combined;
        totalEl.dispatchEvent(new Event('input', { bubbles: true })); // the quote's own autosave takes the total and the rebates together
      }
    }
    redraw();
  }

  // The quote's autosave reads the rebates with the STC total (one save), and Undo puts both back.
  window.hwCredits = {
    read: () => {
      if (!rebateBox.isConnected || rebatesErr) return {};
      const picked = pickedRebates();
      return { rebates: picked, rebates_total: totalOf(picked) };
    },
    apply: (p) => {
      if (!rebateBox.isConnected || !Array.isArray(p.rebates)) return;
      rebateBox.querySelectorAll('.hw-rebate').forEach((rowEl) => {
        const was = p.rebates.find((x) => x.rebate_id === rows[Number(rowEl.dataset.i)].id);
        rowEl.querySelector('.hw-rb-on').checked = !!was;
        if (was) {
          const set = (cls, v) => { const el = rowEl.querySelector(cls); if (el && v != null) el.value = v; };
          set('.hw-rb-count', was.certificates); set('.hw-rb-price', was.price); set('.hw-rb-amount', was.amount);
        }
      });
      sumCredits(false);
    },
  };

  if (!rebatesErr) {
    rebateBox.addEventListener('input', () => { rebatesSeen = true; sumCredits(true); });
    [qtyEl, priceEl].forEach((el) => { if (el) el.addEventListener('input', () => sumCredits(true)); });
  }
  if (firstTime) rebatesSeen = true;
  sumCredits(firstTime);
}
