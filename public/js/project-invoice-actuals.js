// "Invoice actual costs" panel on a job with no quote behind it (project.html, Direct Job:
// dashboard.html's "+ New job (no quote)"). There is no quoted amount to claim a % of, so
// this invoices what has actually accrued, per cost centre, from get-invoiceable-actuals.js:
//   Labour   one row per clocked shift not yet billed (item 41): date, start and finish,
//            who and their rate tier, hours, $/hr, total. "As per Schedule of Rates" (the
//            default) prices each shift by its bands (after hours, Saturday, Sunday, public
//            holiday multipliers) and rounds a person's day up to the 2 hour minimum;
//            "Flat" is one row per person at the base rate. Every row can be edited or
//            removed, "+ Add labour" adds a row by rate tier (travel, someone who did not
//            clock on), and a "Less" line under the rows takes an amount or a percent off,
//            lawyer style. Each row becomes a labour line on the invoice (invoice_line_items,
//            kind labour) naming the shifts it billed, so the next invoice offers only what
//            is left.
//   Materials  at cost marked up by the cost centre's markup%, as one editable amount, plus
//            Stock materials and prebuilds added straight onto the invoice (Stock comes out
//            of the warehouse when the invoice is created).
// Tick the cost centres to invoice, then raise ONE invoice covering all of them (one Xero
// invoice, a Labour / Materials line per cost centre) or a separate invoice for each.
// create-invoice.js prices and checks everything again on the server.
// Needs from project.html / supabase-client.js: supabaseClient, escapeHtml, money, friendlyError,
// getPrebuilds, openVariationStockPicker, wireInvoiceDueDate, shareOrigin, emailInvoiceToClient.

async function openInvoiceActualCostsPanel(project) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `<div class="card" style="max-width:440px; width:100%;"><p class="subtitle">Working out what's accrued...</p></div>`;
  document.body.appendChild(overlay);

  let actuals, prebuilds, materials;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const [res, pbs, { data: mats }] = await Promise.all([
      fetch('/.netlify/functions/get-invoiceable-actuals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ projectId: project.id }),
      }),
      getPrebuilds(),
      supabaseClient.from('materials').select('id, name, cost_price'),
    ]);
    actuals = await res.json();
    if (!res.ok || !actuals.ok) throw new Error(actuals.error || 'Could not work out accrued costs');
    prebuilds = pbs || [];
    materials = mats || [];
  } catch (err) {
    overlay.innerHTML = `<div class="card" style="max-width:440px; width:100%;"><div class="error-box">${escapeHtml(friendlyError(err))}</div><button type="button" class="secondary" id="ia-close-btn" style="margin-top:10px; width:100%;">Close</button></div>`;
    overlay.querySelector('#ia-close-btn').addEventListener('click', () => overlay.remove());
    return;
  }

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const rules = actuals.rules || { minimumHours: 2, bands: { standard: { label: '', multiplier: 1 } } };
  const rateTiers = actuals.rateTiers || [];
  const dateText = (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  // Same pricing create-invoice.js uses (_shared/invoice-items.js), so
  // what's shown here is what gets charged unless it's typed over.
  const prebuildUnitPrice = (p, markup) => {
    const factor = 1 + (Number(markup) || 0) / 100;
    return r2((p.prebuild_components || []).reduce((s, c) => {
      const line = (Number(c.quantity) || 0) * (Number(c.unit_cost) || 0);
      return s + (c.item_type === 'labour' ? line : line * factor);
    }, 0));
  };

  let rateMode = 'schedule'; // 'schedule' (as per Schedule of Rates) or 'flat'
  let mode = 'combined';
  let rowKey = 0;

  const centres = actuals.centres.map((c) => {
    const unbilledHours = r2((c.labourLines || []).reduce((s, l) => s + l.hours, 0));
    // Materials not yet invoiced: what has accrued less what earlier invoices took as a lump
    // (labour lines and Stock items are already left out of both sides by the server).
    const material = r2(Math.max(0, c.materialSell - c.invoicedAmount));
    return { ...c, unbilledHours, material, items: [], labourRows: [], less: { value: 0, unit: '$', reason: '' }, include: unbilledHours > 0 || material > 0.004 };
  });
  // Nothing accrued anywhere yet (e.g. invoicing straight from a prebuild): start with every cost centre ticked.
  if (!centres.some(c => c.include)) centres.forEach(c => { c.include = true; });

  // Labour rows from the clocked shifts, by the chosen rate mode. Hand-added rows and the
  // Less line survive a switch; edits to clocked rows are rebuilt.
  function buildLabourRows() {
    centres.forEach((c) => {
      const kept = c.labourRows.filter(r => r.source === 'added');
      const rows = [];
      if (rateMode === 'flat') {
        const byStaff = new Map();
        (c.labourLines || []).forEach((l) => {
          if (!byStaff.has(l.staffId)) byStaff.set(l.staffId, { key: `r${rowKey++}`, source: 'shift', timeEntryIds: [], staffId: l.staffId, staffName: l.staffName, rateTierId: l.rateTierId, tierName: l.tierName, hours: 0, rate: l.rate });
          const row = byStaff.get(l.staffId);
          row.timeEntryIds.push(l.timeEntryId);
          row.hours = r2(row.hours + l.hours);
        });
        rows.push(...byStaff.values());
      } else {
        (c.labourLines || []).forEach((l) => {
          Object.keys(rules.bands).forEach((band) => {
            const hours = Number(l.bands?.[band]) || 0;
            if (hours <= 0) return;
            const b = rules.bands[band];
            rows.push({ key: `r${rowKey++}`, source: 'shift', timeEntryIds: [l.timeEntryId], staffId: l.staffId, staffName: l.staffName, rateTierId: l.rateTierId, tierName: l.tierName, bandLabel: b.label, dateKey: l.dateKey, start: l.start, end: l.end, hours, rate: r2(l.rate * b.multiplier), minTag: false });
          });
        });
      }
      c.labourRows = [...rows, ...kept];
    });
    if (rateMode === 'schedule') applyMinimum();
  }
  // Minimum charge per person per day on the job (across its cost centres): a short day is
  // rounded up on that person's first row of the day.
  function applyMinimum() {
    const min = Number(rules.minimumHours) || 0;
    if (!min) return;
    const byDay = new Map();
    centres.forEach(c => c.labourRows.forEach((r) => {
      if (r.source !== 'shift' || !r.dateKey) return;
      const k = `${r.staffId}|${r.dateKey}`;
      if (!byDay.has(k)) byDay.set(k, { total: 0, first: r });
      byDay.get(k).total += r.hours;
    }));
    byDay.forEach(({ total, first }) => {
      if (total > 0 && total < min) { first.hours = r2(first.hours + (min - total)); first.minTag = true; }
    });
  }
  buildLabourRows();

  const rowDescription = (r) => {
    if (r.source === 'added') return `${r.tierName}${r.note ? `: ${r.note}` : ''}`;
    const who = `${r.staffName}${r.tierName ? ` (${r.tierName}${r.bandLabel ? `, ${r.bandLabel}` : ''})` : ''}`;
    if (!r.dateKey) return who;
    return `${dateText(r.dateKey)}, ${r.start} to ${r.end}: ${who}${r.minTag ? ` (min. ${rules.minimumHours} hrs)` : ''}`;
  };
  const rowsTotal = (c) => r2(c.labourRows.reduce((s, r) => s + r2((Number(r.hours) || 0) * (Number(r.rate) || 0)), 0));
  // The Less line: a dollar amount or a percent off the labour rows, never more than they add up to.
  const lessAmount = (c) => {
    const v = Number(c.less.value) || 0;
    if (v <= 0) return 0;
    const off = c.less.unit === '%' ? r2(rowsTotal(c) * v / 100) : r2(v);
    return -Math.min(off, rowsTotal(c));
  };
  const labourTotal = (c) => r2(rowsTotal(c) + lessAmount(c));
  const centreTotal = (c) => r2(labourTotal(c) + (Number(c.material) || 0) + c.items.reduce((s, it) => s + r2(it.quantity * it.unitPrice), 0));

  overlay.innerHTML = `
    <div class="card" style="max-width:860px; width:100%; max-height:90vh; overflow-y:auto;">
      <h2>Invoice actual costs</h2>
      <p class="subtitle" style="margin-bottom:10px;">Tick the cost centres to invoice. Labour is every clocked shift not yet billed; change the hours or rate on any line, remove one, add a line, or take some off at the bottom. Add Stock materials or prebuilds straight onto the invoice (Stock comes out of the warehouse when the invoice is created).</p>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
        <span style="font-weight:600;">Labour rates</span>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-rate-mode" value="schedule" checked style="width:auto;" /> As per Schedule of Rates</label>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-rate-mode" value="flat" style="width:auto;" /> Flat</label>
      </div>
      <p class="subtitle" id="ia-rate-note" style="font-size:12px; margin:-6px 0 12px;"></p>
      <div id="ia-centres"></div>
      <div id="ia-mode-wrap" style="margin-top:12px;"></div>
      <div class="grid cols-2">
        <div><label>Invoice date</label><input type="date" id="ia-date" value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })}" /></div>
        <div><label>Due date</label><input type="date" id="ia-due-date" /><p class="subtitle" id="ia-due-note" style="font-size:12px; margin:4px 0 0;"></p></div>
      </div>
      <p id="ia-total" style="margin:14px 0 0; font-weight:600;"></p>
      <div style="margin-top:14px;">
        <button id="ia-confirm-btn">Create invoice</button>
        <button type="button" class="secondary" id="ia-cancel-btn">Cancel</button>
      </div>
      <div id="ia-msg"></div>
    </div>`;

  wireInvoiceDueDate(overlay, { dateSel: '#ia-date', dueSel: '#ia-due-date', noteSel: '#ia-due-note', clientId: project.client_id });
  const centresEl = overlay.querySelector('#ia-centres');
  const modeWrap = overlay.querySelector('#ia-mode-wrap');
  const rateNote = overlay.querySelector('#ia-rate-note');
  const setRateNote = () => {
    rateNote.textContent = rateMode === 'schedule'
      ? `${rules.standardHours || 'Standard hours'}; outside them ${rules.bands.after_hours?.multiplier || 1.5}x, Saturday ${rules.bands.saturday?.multiplier || 1.5}x, Sunday ${rules.bands.sunday?.multiplier || 2}x, public holiday ${rules.bands.public_holiday?.multiplier || 2.5}x; minimum ${rules.minimumHours} hours per person per day. Switching rebuilds the clocked rows.`
      : 'Every hour at the person\'s base rate, as clocked. Switching rebuilds the clocked rows.';
  };
  setRateNote();
  overlay.querySelectorAll('input[name="ia-rate-mode"]').forEach(r => r.addEventListener('change', () => {
    rateMode = r.value;
    setRateNote();
    buildLabourRows();
    renderCentres();
  }));

  function refreshTotals() {
    const picked = centres.filter(c => c.include);
    const total = picked.reduce((s, c) => s + centreTotal(c), 0);
    overlay.querySelector('#ia-total').textContent = picked.length
      ? `${mode === 'separate' && picked.length > 1 ? `${picked.length} invoices, ` : ''}${money(total)} ex GST`
      : 'Tick at least one cost centre.';
    centres.forEach((c, i) => {
      const box = centresEl.querySelector(`[data-ci="${i}"]`);
      if (!box) return;
      box.querySelector('.ia-centre-total').textContent = money(centreTotal(c));
      const lessEl = box.querySelector('.ia-less-amount');
      if (lessEl) lessEl.textContent = lessAmount(c) ? money(lessAmount(c)) : '';
      const labEl = box.querySelector('.ia-labour-total');
      if (labEl) labEl.textContent = money(labourTotal(c));
    });
    modeWrap.innerHTML = picked.length > 1 ? `
      <label style="margin-top:0;">How to invoice the ${picked.length} cost centres</label>
      <label style="display:flex; align-items:center; gap:8px; margin-top:4px; font-weight:400;"><input type="radio" name="ia-mode" value="combined" ${mode === 'combined' ? 'checked' : ''} style="width:auto;" /> One invoice covering all of them</label>
      <label style="display:flex; align-items:center; gap:8px; margin-top:4px; font-weight:400;"><input type="radio" name="ia-mode" value="separate" ${mode === 'separate' ? 'checked' : ''} style="width:auto;" /> A separate invoice for each</label>` : '';
    modeWrap.querySelectorAll('input[name="ia-mode"]').forEach(r => r.addEventListener('change', () => { mode = r.value; refreshTotals(); }));
  }

  const num = (v, step = '0.01') => `type="number" step="${step}" inputmode="decimal" style="padding:4px 6px; margin:0; min-width:70px;"`;
  function labourRowHtml(r, j) {
    const schedule = rateMode === 'schedule';
    const who = r.source === 'added'
      ? `<select class="ia-row-tier" style="padding:4px 6px; margin:0; min-width:120px;">${rateTiers.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === r.rateTierId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
         <input class="ia-row-note" value="${escapeHtml(r.note || '')}" placeholder="Note (e.g. travel)" style="padding:4px 6px; margin:4px 0 0; min-width:120px;" />`
      : `${escapeHtml(r.staffName)}${r.tierName ? ` <span class="subtitle" style="font-size:11px;">${escapeHtml(r.tierName)}${r.bandLabel ? `, ${escapeHtml(r.bandLabel)}` : ''}</span>` : ''}${r.minTag ? ` <span class="subtitle" style="font-size:11px;">min. ${rules.minimumHours} hrs</span>` : ''}`;
    return `
      <tr data-lr="${j}">
        ${schedule ? `<td style="white-space:nowrap;">${r.dateKey ? escapeHtml(dateText(r.dateKey)) : ''}</td><td style="white-space:nowrap;">${r.start ? `${escapeHtml(r.start)} to ${escapeHtml(r.end)}` : ''}</td>` : ''}
        <td>${who}</td>
        <td class="num"><input class="ia-row-hours" ${num(r.hours)} min="0" value="${r.hours}" /></td>
        <td class="num"><input class="ia-row-rate" ${num(r.rate)} min="0" value="${r.rate}" /></td>
        <td class="num ia-row-total" style="white-space:nowrap;">${money(r2(r.hours * r.rate))}</td>
        <td><button type="button" class="secondary ia-row-remove" aria-label="Remove" title="Remove" style="font-size:14px; padding:2px 8px;">&times;</button></td>
      </tr>`;
  }

  function renderCentres() {
    const schedule = rateMode === 'schedule';
    centresEl.innerHTML = centres.map((c, i) => `
      <div data-ci="${i}" style="border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; ${c.include ? '' : 'opacity:0.6;'}">
        <label style="margin-top:0; display:flex; align-items:center; gap:8px; justify-content:space-between;">
          <span style="display:flex; align-items:center; gap:8px;"><input type="checkbox" class="ia-include" ${c.include ? 'checked' : ''} style="width:auto;" /><strong>${escapeHtml(c.name)}</strong></span>
          <span class="ia-centre-total" style="font-weight:600;"></span>
        </label>
        <p class="subtitle" style="margin:4px 0 0; font-size:12px;">${c.unbilledHours} hrs not yet billed (${c.actualHours} logged) &middot; ${money(c.materialCost)} materials at cost (${money(c.materialSell)} with ${c.markupPercent}% markup) &middot; ${money(c.invoicedAmount)} already invoiced</p>
        ${c.include ? `
          <p style="margin:10px 0 4px; font-weight:600;">Labour</p>
          <div style="overflow-x:auto;">
            <table style="font-size:13px; min-width:${schedule ? '620px' : '420px'};">
              <thead><tr>${schedule ? '<th>Date</th><th>Time</th>' : ''}<th>Who</th><th class="num" style="width:80px;">Hours</th><th class="num" style="width:90px;">$/hr</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>
                ${c.labourRows.length ? c.labourRows.map((r, j) => labourRowHtml(r, j)).join('') : `<tr><td colspan="${schedule ? 7 : 5}" class="subtitle">No labour on this cost centre yet.</td></tr>`}
                <tr>
                  <td colspan="${schedule ? 3 : 1}" style="white-space:nowrap;">Less
                    <input class="ia-less-value" type="number" step="0.01" inputmode="decimal" min="0" value="${c.less.value || ''}" placeholder="0" style="padding:4px 6px; margin:0 4px; width:80px; display:inline-block;" />
                    <select class="ia-less-unit" style="padding:4px 6px; margin:0; width:auto; display:inline-block;"><option value="$" ${c.less.unit === '$' ? 'selected' : ''}>$</option><option value="%" ${c.less.unit === '%' ? 'selected' : ''}>%</option></select>
                    <input class="ia-less-reason" value="${escapeHtml(c.less.reason)}" placeholder="Reason (e.g. goodwill)" style="padding:4px 6px; margin:4px 0 0; min-width:140px; display:inline-block; width:auto;" />
                  </td>
                  <td colspan="2"></td>
                  <td class="num ia-less-amount" style="white-space:nowrap;"></td>
                  <td></td>
                </tr>
                <tr><td colspan="${schedule ? 5 : 3}" style="text-align:right; font-weight:600;">Labour total</td><td class="num ia-labour-total" style="font-weight:600; white-space:nowrap;"></td><td></td></tr>
              </tbody>
            </table>
          </div>
          <button type="button" class="secondary ia-add-labour" style="margin-top:8px; font-size:13px;" ${rateTiers.length ? '' : 'disabled title="Set up Billable Rates first"'}>+ Add labour</button>
          <div class="grid cols-2" style="margin-top:6px;">
            <div><label>Materials</label><input type="number" step="0.01" inputmode="decimal" class="ia-material" value="${c.material}" /></div>
          </div>
          ${c.items.length ? `
            <table style="margin-top:10px; font-size:13px;">
              <thead><tr><th>Added item</th><th class="num" style="width:70px;">Qty</th><th class="num" style="width:110px;">Price each</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>
                ${c.items.map((it, j) => `
                  <tr data-ii="${j}">
                    <td>${escapeHtml(it.name)} <span class="subtitle" style="font-size:11px;">${it.kind === 'prebuild' ? 'Prebuild' : 'Stock'}</span></td>
                    <td class="num"><input type="number" step="0.01" min="0.01" class="ia-item-qty" value="${it.quantity}" style="padding:4px 6px;" /></td>
                    <td class="num"><input type="number" step="0.01" min="0" class="ia-item-price" value="${it.unitPrice}" style="padding:4px 6px;" /></td>
                    <td class="num ia-item-total">${money(it.quantity * it.unitPrice)}</td>
                    <td><button type="button" class="secondary ia-item-remove" style="font-size:12px; padding:4px 8px;">Remove</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>` : ''}
          <button type="button" class="secondary ia-add-item" style="margin-top:10px; font-size:13px;">+ Add from Stock / prebuild</button>
        ` : ''}
      </div>`).join('');

    centresEl.querySelectorAll('[data-ci]').forEach((box) => {
      const c = centres[Number(box.dataset.ci)];
      box.querySelector('.ia-include').addEventListener('change', (e) => { c.include = e.target.checked; renderCentres(); });
      if (!c.include) return;
      box.querySelectorAll('[data-lr]').forEach((tr) => {
        const r = c.labourRows[Number(tr.dataset.lr)];
        const sync = () => { tr.querySelector('.ia-row-total').textContent = money(r2(r.hours * r.rate)); refreshTotals(); };
        tr.querySelector('.ia-row-hours').addEventListener('input', (e) => { r.hours = parseFloat(e.target.value) || 0; r.minTag = false; sync(); });
        tr.querySelector('.ia-row-rate').addEventListener('input', (e) => { r.rate = parseFloat(e.target.value) || 0; sync(); });
        tr.querySelector('.ia-row-remove').addEventListener('click', () => { c.labourRows.splice(Number(tr.dataset.lr), 1); renderCentres(); });
        const tierSel = tr.querySelector('.ia-row-tier');
        if (tierSel) tierSel.addEventListener('change', (e) => {
          const t = rateTiers.find(x => x.id === e.target.value);
          r.rateTierId = t?.id || null; r.tierName = t?.name || ''; r.rate = t ? t.sellRate : r.rate;
          tr.querySelector('.ia-row-rate').value = r.rate;
          sync();
        });
        const noteEl = tr.querySelector('.ia-row-note');
        if (noteEl) noteEl.addEventListener('input', (e) => { r.note = e.target.value.trim(); });
      });
      box.querySelector('.ia-less-value').addEventListener('input', (e) => { c.less.value = parseFloat(e.target.value) || 0; refreshTotals(); });
      box.querySelector('.ia-less-unit').addEventListener('change', (e) => { c.less.unit = e.target.value; refreshTotals(); });
      box.querySelector('.ia-less-reason').addEventListener('input', (e) => { c.less.reason = e.target.value.trim(); });
      box.querySelector('.ia-add-labour').addEventListener('click', () => {
        const t = rateTiers[0];
        c.labourRows.push({ key: `r${rowKey++}`, source: 'added', timeEntryIds: [], staffId: null, staffName: '', rateTierId: t.id, tierName: t.name, hours: 1, rate: t.sellRate, note: '' });
        renderCentres();
      });
      box.querySelector('.ia-material').addEventListener('input', (e) => { c.material = parseFloat(e.target.value) || 0; refreshTotals(); });
      box.querySelectorAll('[data-ii]').forEach((row) => {
        const it = c.items[Number(row.dataset.ii)];
        const sync = () => { row.querySelector('.ia-item-total').textContent = money(it.quantity * it.unitPrice); refreshTotals(); };
        row.querySelector('.ia-item-qty').addEventListener('input', (e) => { it.quantity = parseFloat(e.target.value) || 0; sync(); });
        row.querySelector('.ia-item-price').addEventListener('input', (e) => { it.unitPrice = parseFloat(e.target.value) || 0; sync(); });
        row.querySelector('.ia-item-remove').addEventListener('click', () => { c.items.splice(Number(row.dataset.ii), 1); renderCentres(); });
      });
      box.querySelector('.ia-add-item').addEventListener('click', async () => {
        const picked = await openVariationStockPicker(true);
        if (!picked) return;
        if (picked.kind === 'material') {
          const m = materials.find(x => x.id === picked.id);
          c.items.push({ kind: 'material', materialId: picked.id, name: picked.name, quantity: picked.quantity, unitPrice: r2((Number(m?.cost_price) || 0) * (1 + c.markupPercent / 100)) });
        } else {
          const p = prebuilds.find(x => x.id === picked.id);
          c.items.push({ kind: 'prebuild', prebuildId: picked.id, name: picked.name, quantity: picked.quantity, unitPrice: p ? prebuildUnitPrice(p, c.markupPercent) : 0 });
        }
        renderCentres();
      });
    });
    refreshTotals();
  }
  renderCentres();

  overlay.querySelector('#ia-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ia-confirm-btn').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#ia-confirm-btn');
    const msg = overlay.querySelector('#ia-msg');
    const picked = centres.filter(c => c.include);
    if (!picked.length) { msg.innerHTML = `<div class="error-box">Tick at least one cost centre.</div>`; return; }
    const empty = picked.find(c => centreTotal(c) <= 0);
    if (empty) { msg.innerHTML = `<div class="error-box">${escapeHtml(empty.name)} has nothing to invoice. Enter an amount, add a line, or untick it.</div>`; return; }
    if (picked.some(c => c.items.some(it => !(it.quantity > 0)))) { msg.innerHTML = `<div class="error-box">Every added item needs a quantity.</div>`; return; }
    if (picked.some(c => c.labourRows.some(r => !(r.hours > 0) || r.rate < 0))) { msg.innerHTML = `<div class="error-box">Every labour line needs hours and a rate. Remove a line you do not want to bill.</div>`; return; }

    const toClaim = (c) => ({
      costCentreId: c.costCentreId, labourAmount: 0, materialAmount: Number(c.material) || 0, claimPercent: null,
      items: [
        ...c.labourRows.map(r => ({ kind: 'labour', staffId: r.staffId || null, rateTierId: r.rateTierId || null, timeEntryIds: r.timeEntryIds, quantity: r.hours, unitPrice: r.rate, description: rowDescription(r) })),
        ...(lessAmount(c) < 0 ? [{ kind: 'labour', quantity: 1, unitPrice: lessAmount(c), description: `Less: ${c.less.reason || 'adjustment'}` }] : []),
        ...c.items.map(it => ({ kind: it.kind, materialId: it.materialId || null, prebuildId: it.prebuildId || null, quantity: it.quantity, unitPrice: it.unitPrice })),
      ],
    });
    const batches = mode === 'separate' ? picked.map(c => [toClaim(c)]) : [picked.map(toClaim)];

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creating...';
    const created = [];
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      for (const claims of batches) {
        const res = await fetch('/.netlify/functions/create-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            projectId: project.id,
            claims,
            sentAt: overlay.querySelector('#ia-date').value || null,
            dueDate: overlay.querySelector('#ia-due-date').value || null,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not create invoice');
        created.push(data);
      }
    } catch (err) {
      msg.innerHTML = `${created.length ? `<div class="success-box">Created ${created.map(d => d.invoiceNumber).join(', ')} before this failed.</div>` : ''}<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      if (created.length) {
        confirmBtn.style.display = 'none';
        overlay.querySelector('#ia-cancel-btn').textContent = 'Close';
        overlay.querySelector('#ia-cancel-btn').addEventListener('click', () => window.location.reload());
      } else {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Create invoice';
      }
      return;
    }

    msg.innerHTML = `
      <div class="success-box">Created ${escapeHtml(created.map(d => d.invoiceNumber).join(', '))}.</div>
      ${created.map(d => `
        <label>${escapeHtml(d.invoiceNumber)} link</label><input readonly value="${escapeHtml(`${shareOrigin()}/invoice.html?token=${d.invoiceToken}`)}" onclick="this.select()" />
        <button type="button" class="ia-email-btn" data-id="${escapeHtml(d.invoiceId)}" style="margin-top:8px;">Email ${escapeHtml(d.invoiceNumber)} to client</button>
        <div class="ia-email-msg"></div>`).join('')}`;
    msg.querySelectorAll('.ia-email-btn').forEach(b => b.addEventListener('click', () => emailInvoiceToClient(b.dataset.id, project, { btn: b, msgEl: b.nextElementSibling })));
    confirmBtn.style.display = 'none';
    overlay.querySelector('#ia-cancel-btn').textContent = 'Close';
    overlay.querySelector('#ia-cancel-btn').addEventListener('click', () => window.location.reload());
  });
}
