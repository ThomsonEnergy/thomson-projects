// "Invoice actual costs" panel on a job with no quote behind it (project.html, Direct Job:
// dashboard.html's "+ New job (no quote)"). There is no quoted amount to claim a % of, so
// this invoices what has actually accrued, per cost centre, from get-invoiceable-actuals.js:
//   Labour   one row per clocked shift not yet billed (item 41): date, start and finish,
//            who and their rate tier, hours, $/hr, total. "As per Schedule of Rates" (the
//            default) prices each shift by its bands (after hours, Saturday, Sunday, public
//            holiday multipliers) and rounds a person's day up to the 2 hour minimum;
//            "Flat" is one row per person at the base rate. A rate tier dropdown next to each
//            person (item 59) bills all of that person's rows on this invoice at another tier
//            (bands applied again, typed hours kept). Every row can be edited,
//            "+ Add labour" adds a row by rate tier (travel, someone who did not clock on),
//            and a "Less" line under the rows takes an amount or a percent off, lawyer
//            style. A job under a commercial agreement (item 48) shows one more line, the
//            agreement's percent off the labour rows (after Less), which create-invoice.js
//            works out and adds itself; the $/hr above it stay the full Schedule of Rates. Each row becomes a labour line on the invoice (invoice_line_items, kind
//            labour) naming the shifts it billed, so the next invoice offers only what is left.
//   Materials  "Itemised" (the default): one row per PO line received to the job or Stock
//            draw not yet billed (job_material_usage), at cost plus the cost centre's markup,
//            each editable; "Bulk": one editable Materials amount. Stock materials and
//            prebuilds can be added straight onto the invoice too (Stock comes out of the
//            warehouse when the invoice is created).
//   Bill tick  every clocked shift and costed material has a Bill tick. Unticked, it is left
//            off this invoice and marked not billable on the job when the invoice is created,
//            so it stays off the next one (it shows greyed at the bottom: tick it to bill it).
//   Notes    "Work completed" (item 59, invoices.notes), written from the site notes by
//            generate-invoice-notes.js (js/invoice-notes.js) and edited, printed above the terms.
// Tick the cost centres to invoice, then raise ONE invoice covering all of them (one Xero
// invoice, a Labour / Materials line per cost centre) or a separate invoice for each.
// create-invoice.js prices and checks everything again on the server.
// Needs from project.html / supabase-client.js: supabaseClient, escapeHtml, money, friendlyError,
// getPrebuilds, openVariationStockPicker, wireInvoiceDueDate, shareOrigin, loadInvoiceActions (which
// brings emailInvoiceToClient from js/invoice-actions.js).

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

  let rateMode = 'schedule'; // labour: 'schedule' (as per Schedule of Rates) or 'flat'
  let materialMode = 'itemised'; // materials: 'itemised' or 'bulk'
  let mode = 'combined';
  let rowKey = 0;
  // A different rate tier picked for a person on this invoice (item 59): staffId -> tier. Kept across
  // rebuilds (rate mode switch, Bill tick), so every clocked row of theirs is billed at it.
  const tierOverride = {};
  const tierFor = (l) => {
    const t = tierOverride[l.staffId];
    return t ? { rateTierId: t.id, tierName: t.name, rate: t.sellRate } : { rateTierId: l.rateTierId, tierName: l.tierName, rate: l.rate };
  };

  const centres = actuals.centres.map((c) => {
    const unbilledHours = r2((c.labourLines || []).filter(l => l.billable).reduce((s, l) => s + l.hours, 0));
    // Bulk materials not yet invoiced: what has accrued less what earlier invoices took as a lump
    // (labour lines and itemised materials are already left out of both sides by the server).
    const material = r2(Math.max(0, c.materialSell - c.invoicedAmount));
    const materialRows = (c.materialLines || []).map(m => ({ ...m, key: `m${rowKey++}`, source: 'usage' }));
    return { ...c, unbilledHours, material, materialRows, items: [], labourRows: [], less: { value: 0, unit: '$', reason: '' }, include: unbilledHours > 0 || material > 0.004 || materialRows.some(m => m.billable) };
  });
  // Nothing accrued anywhere yet (e.g. invoicing straight from a prebuild): start with every cost centre ticked.
  if (!centres.some(c => c.include)) centres.forEach(c => { c.include = true; });

  // Labour rows from the clocked shifts, by the chosen rate mode. Hand-added rows and the
  // Less line survive a switch; edits to clocked rows are rebuilt. Not-billable rows sort last.
  function buildLabourRows() {
    centres.forEach((c) => {
      const kept = c.labourRows.filter(r => r.source === 'added');
      const rows = [];
      if (rateMode === 'flat') {
        const byStaff = new Map();
        (c.labourLines || []).forEach((l) => {
          const k = `${l.staffId}|${l.billable ? 1 : 0}`;
          if (!byStaff.has(k)) byStaff.set(k, { key: `r${rowKey++}`, source: 'shift', timeEntryIds: [], staffId: l.staffId, staffName: l.staffName, ...tierFor(l), mult: 1, hours: 0, billable: l.billable });
          const row = byStaff.get(k);
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
            const t = tierFor(l);
            rows.push({ key: `r${rowKey++}`, source: 'shift', timeEntryIds: [l.timeEntryId], staffId: l.staffId, staffName: l.staffName, rateTierId: t.rateTierId, tierName: t.tierName, bandLabel: b.label, dateKey: l.dateKey, start: l.start, end: l.end, hours, rate: r2(t.rate * b.multiplier), mult: b.multiplier, minTag: false, billable: l.billable });
          });
        });
      }
      rows.sort((a, b) => (a.billable === b.billable ? 0 : a.billable ? -1 : 1));
      c.labourRows = [...rows, ...kept];
    });
    if (rateMode === 'schedule') applyMinimum();
  }
  // Minimum charge per person per day on the job (across its cost centres): a short day is
  // rounded up on that person's first billable row of the day.
  function applyMinimum() {
    const min = Number(rules.minimumHours) || 0;
    if (!min) return;
    const byDay = new Map();
    centres.forEach(c => c.labourRows.forEach((r) => {
      if (r.source !== 'shift' || !r.dateKey || !r.billable) return;
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
  const billedLabour = (c) => c.labourRows.filter(r => r.billable !== false);
  const rowsTotal = (c) => r2(billedLabour(c).reduce((s, r) => s + r2((Number(r.hours) || 0) * (Number(r.rate) || 0)), 0));
  // The Less line: a dollar amount or a percent off the labour rows, never more than they add up to.
  const lessAmount = (c) => {
    const v = Number(c.less.value) || 0;
    if (v <= 0) return 0;
    const off = c.less.unit === '%' ? r2(rowsTotal(c) * v / 100) : r2(v);
    return -Math.min(off, rowsTotal(c));
  };
  // The commercial agreement's own line (item 48): its percent off the labour after the Less line, the
  // same figure create-invoice.js adds (the panel never sends it).
  const percentOff = Number(actuals.rateCard?.percentOff) || 0;
  const agreementAmount = (c) => (percentOff > 0 ? -r2((rowsTotal(c) + lessAmount(c)) * percentOff / 100) : 0);
  const labourTotal = (c) => r2(rowsTotal(c) + lessAmount(c) + agreementAmount(c));
  const billedMaterials = (c) => c.materialRows.filter(m => m.billable);
  const materialTotal = (c) => (materialMode === 'bulk'
    ? r2(Number(c.material) || 0)
    : r2(billedMaterials(c).reduce((s, m) => s + r2((Number(m.quantity) || 0) * (Number(m.unitPrice) || 0)), 0)));
  const centreTotal = (c) => r2(labourTotal(c) + materialTotal(c) + c.items.reduce((s, it) => s + r2(it.quantity * it.unitPrice), 0));

  overlay.innerHTML = `
    <div class="card" style="max-width:900px; width:100%; max-height:90vh; overflow-y:auto;">
      <h2>Invoice actual costs</h2>
      <p class="subtitle" style="margin-bottom:10px;">Tick the cost centres to invoice. Labour is every clocked shift not yet billed and materials every PO line or Stock draw costed to the job; change any line or the rate tier next to a person, untick Bill to leave one off (it stays off next time too), add a line, or take some off at the bottom. Stock comes out of the warehouse when an added Stock item is invoiced.</p>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:6px;">
        <span style="font-weight:600;">Labour rates</span>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-rate-mode" value="schedule" checked style="width:auto;" /> As per Schedule of Rates</label>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-rate-mode" value="flat" style="width:auto;" /> Flat</label>
      </div>
      <p class="subtitle" id="ia-rate-note" style="font-size:12px; margin:0 0 8px;"></p>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
        <span style="font-weight:600;">Materials</span>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-material-mode" value="itemised" checked style="width:auto;" /> Itemised (each PO line and Stock draw)</label>
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="radio" name="ia-material-mode" value="bulk" style="width:auto;" /> Bulk (one amount)</label>
      </div>
      <div id="ia-centres"></div>
      <div id="ia-mode-wrap" style="margin-top:12px;"></div>
      <div class="grid cols-2">
        <div><label>Invoice date</label><input type="date" id="ia-date" value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })}" /></div>
        <div><label>Due date</label><input type="date" id="ia-due-date" /><p class="subtitle" id="ia-due-note" style="font-size:12px; margin:4px 0 0;"></p></div>
      </div>
      <label>Notes on the invoice (Work completed)</label>
      <textarea id="ia-notes" rows="4" maxlength="2000" placeholder="What was done on site. Printed on the client's invoice above the terms."></textarea>
      <button type="button" class="secondary" id="ia-notes-write-btn" style="margin-top:6px; font-size:13px;">Write from the site notes</button>
      <div id="ia-notes-msg"></div>
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
  const levelNote = percentOff > 0
    ? ` Commercial agreement: ${actuals.rateCard.name}, ${percentOff}% off labour, added as its own line under the full rates.`
    : (actuals.rateCard && Number(actuals.rateCard.percent) > 100 ? ` Charge rates: ${actuals.rateCard.name} (${actuals.rateCard.percent}% of the Schedule of Rates).` : '');
  const setRateNote = () => {
    rateNote.textContent = levelNote + (rateMode === 'schedule'
      ? `${rules.standardHours || 'Standard hours'}; outside them ${rules.bands.after_hours?.multiplier || 1.5}x, Saturday ${rules.bands.saturday?.multiplier || 1.5}x, Sunday ${rules.bands.sunday?.multiplier || 2}x, public holiday ${rules.bands.public_holiday?.multiplier || 2.5}x; minimum ${rules.minimumHours} hours per person per day. Switching rebuilds the clocked rows.`
      : 'Every hour at the person\'s base rate, as clocked. Switching rebuilds the clocked rows.');
  };
  setRateNote();
  overlay.querySelectorAll('input[name="ia-rate-mode"]').forEach(r => r.addEventListener('change', () => {
    rateMode = r.value;
    setRateNote();
    buildLabourRows();
    renderCentres();
  }));
  overlay.querySelectorAll('input[name="ia-material-mode"]').forEach(r => r.addEventListener('change', () => { materialMode = r.value; renderCentres(); }));

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
      const set = (sel, text) => { const el = box.querySelector(sel); if (el) el.textContent = text; };
      set('.ia-less-amount', lessAmount(c) ? money(lessAmount(c)) : '');
      set('.ia-agreement-amount', agreementAmount(c) ? money(agreementAmount(c)) : '');
      set('.ia-labour-total', money(labourTotal(c)));
      set('.ia-material-total', money(materialTotal(c)));
    });
    modeWrap.innerHTML = picked.length > 1 ? `
      <label style="margin-top:0;">How to invoice the ${picked.length} cost centres</label>
      <label style="display:flex; align-items:center; gap:8px; margin-top:4px; font-weight:400;"><input type="radio" name="ia-mode" value="combined" ${mode === 'combined' ? 'checked' : ''} style="width:auto;" /> One invoice covering all of them</label>
      <label style="display:flex; align-items:center; gap:8px; margin-top:4px; font-weight:400;"><input type="radio" name="ia-mode" value="separate" ${mode === 'separate' ? 'checked' : ''} style="width:auto;" /> A separate invoice for each</label>` : '';
    modeWrap.querySelectorAll('input[name="ia-mode"]').forEach(r => r.addEventListener('change', () => { mode = r.value; refreshTotals(); }));
  }

  const num = (v) => `type="number" step="0.01" inputmode="decimal" value="${v}" style="padding:4px 6px; margin:0; min-width:70px;"`;
  const billTick = (cls, on) => `<input type="checkbox" class="${cls}" ${on ? 'checked' : ''} title="Bill this line" style="width:auto; margin:0;" />`;
  const removeBtn = (cls) => `<button type="button" class="secondary ${cls}" aria-label="Remove" title="Remove" style="font-size:14px; padding:2px 8px;">&times;</button>`;
  // The rate tier a clocked person is billed at (item 59): picking one reprices all their rows.
  const staffTierPick = (r, off) => (rateTiers.length
    ? ` <select class="ia-staff-tier" title="Bill this person's hours at another rate tier" ${off ? 'disabled' : ''} style="padding:2px 4px; margin:2px 0 0; width:auto; display:inline-block; font-size:12px;">${r.rateTierId && rateTiers.some(t => t.id === r.rateTierId) ? '' : `<option value="">${escapeHtml(r.tierName || 'No rate tier')}</option>`}${rateTiers.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === r.rateTierId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>`
    : (r.tierName ? ` <span class="subtitle" style="font-size:11px;">${escapeHtml(r.tierName)}</span>` : ''));
  function labourRowHtml(r, j) {
    const schedule = rateMode === 'schedule';
    const off = r.billable === false;
    const who = r.source === 'added'
      ? `<select class="ia-row-tier" style="padding:4px 6px; margin:0; min-width:120px;">${rateTiers.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === r.rateTierId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
         <input class="ia-row-note" value="${escapeHtml(r.note || '')}" placeholder="Note (e.g. travel)" style="padding:4px 6px; margin:4px 0 0; min-width:120px;" />`
      : `${escapeHtml(r.staffName)}${staffTierPick(r, off)}${r.bandLabel ? ` <span class="subtitle" style="font-size:11px;">${escapeHtml(r.bandLabel)}</span>` : ''}${r.minTag ? ` <span class="subtitle" style="font-size:11px;">min. ${rules.minimumHours} hrs</span>` : ''}${off ? ` <span class="subtitle" style="font-size:11px;">not billable</span>` : ''}`;
    return `
      <tr data-lr="${j}" style="${off ? 'opacity:0.5;' : ''}">
        <td>${r.source === 'added' ? '' : billTick('ia-row-bill', !off)}</td>
        ${schedule ? `<td style="white-space:nowrap;">${r.dateKey ? escapeHtml(dateText(r.dateKey)) : ''}</td><td style="white-space:nowrap;">${r.start ? `${escapeHtml(r.start)} to ${escapeHtml(r.end)}` : ''}</td>` : ''}
        <td>${who}</td>
        <td class="num"><input class="ia-row-hours" ${num(r.hours)} min="0" ${off ? 'disabled' : ''} /></td>
        <td class="num"><input class="ia-row-rate" ${num(r.rate)} min="0" ${off ? 'disabled' : ''} /></td>
        <td class="num ia-row-total" style="white-space:nowrap;">${off ? '' : money(r2(r.hours * r.rate))}</td>
        <td>${r.source === 'added' ? removeBtn('ia-row-remove') : ''}</td>
      </tr>`;
  }
  function materialRowHtml(m, j) {
    const off = !m.billable;
    return `
      <tr data-mr="${j}" style="${off ? 'opacity:0.5;' : ''}">
        <td>${billTick('ia-mat-bill', !off)}</td>
        <td>${escapeHtml(m.description)}${off ? ` <span class="subtitle" style="font-size:11px;">not billable</span>` : ''}</td>
        <td style="white-space:nowrap;">${escapeHtml(m.from || '')}</td>
        <td class="num"><input class="ia-mat-qty" ${num(m.quantity)} min="0" ${off ? 'disabled' : ''} /></td>
        <td class="num" style="white-space:nowrap;">${money(m.unitCost)}</td>
        <td class="num"><input class="ia-mat-price" ${num(m.unitPrice)} min="0" ${off ? 'disabled' : ''} /></td>
        <td class="num ia-mat-total" style="white-space:nowrap;">${off ? '' : money(r2(m.quantity * m.unitPrice))}</td>
      </tr>`;
  }

  function renderCentres() {
    const schedule = rateMode === 'schedule';
    const labourCols = schedule ? 8 : 6;
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
            <table style="font-size:13px; min-width:${schedule ? '660px' : '460px'};">
              <thead><tr><th style="width:36px;">Bill</th>${schedule ? '<th>Date</th><th>Time</th>' : ''}<th>Who</th><th class="num" style="width:80px;">Hours</th><th class="num" style="width:90px;">$/hr</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>
                ${c.labourRows.length ? c.labourRows.map((r, j) => labourRowHtml(r, j)).join('') : `<tr><td colspan="${labourCols}" class="subtitle">No labour on this cost centre yet.</td></tr>`}
                <tr>
                  <td colspan="${labourCols - 4}" style="white-space:nowrap;">Less
                    <input class="ia-less-value" type="number" step="0.01" inputmode="decimal" min="0" value="${c.less.value || ''}" placeholder="0" style="padding:4px 6px; margin:0 4px; width:80px; display:inline-block;" />
                    <select class="ia-less-unit" style="padding:4px 6px; margin:0; width:auto; display:inline-block;"><option value="$" ${c.less.unit === '$' ? 'selected' : ''}>$</option><option value="%" ${c.less.unit === '%' ? 'selected' : ''}>%</option></select>
                    <input class="ia-less-reason" value="${escapeHtml(c.less.reason)}" placeholder="Reason (e.g. goodwill)" style="padding:4px 6px; margin:4px 0 0; min-width:140px; display:inline-block; width:auto;" />
                  </td>
                  <td colspan="2"></td>
                  <td class="num ia-less-amount" style="white-space:nowrap;"></td>
                  <td></td>
                </tr>
                ${percentOff > 0 ? `<tr><td colspan="${labourCols - 2}">Commercial agreement (${escapeHtml(actuals.rateCard.name)}): ${percentOff}% off labour</td><td class="num ia-agreement-amount" style="white-space:nowrap;"></td><td></td></tr>` : ''}
                <tr><td colspan="${labourCols - 2}" style="text-align:right; font-weight:600;">Labour total</td><td class="num ia-labour-total" style="font-weight:600; white-space:nowrap;"></td><td></td></tr>
              </tbody>
            </table>
          </div>
          <button type="button" class="secondary ia-add-labour" style="margin-top:8px; font-size:13px;" ${rateTiers.length ? '' : 'disabled title="Set up Billable Rates first"'}>+ Add labour</button>
          <p style="margin:14px 0 4px; font-weight:600;">Materials</p>
          ${materialMode === 'bulk' ? `
            <div class="grid cols-2">
              <div><label style="margin-top:0;">Materials (one amount)</label><input type="number" step="0.01" inputmode="decimal" class="ia-material" value="${c.material}" /></div>
            </div>
            <p class="subtitle" style="font-size:12px; margin:4px 0 0;">${c.materialRows.filter(m => m.billable).length} costed line${c.materialRows.filter(m => m.billable).length === 1 ? '' : 's'} are billed as this one amount; switch to Itemised to see them.</p>` : `
            <div style="overflow-x:auto;">
              <table style="font-size:13px; min-width:620px;">
                <thead><tr><th style="width:36px;">Bill</th><th>Item</th><th>From</th><th class="num" style="width:80px;">Qty</th><th class="num">Cost each</th><th class="num" style="width:100px;">Price each</th><th class="num">Total</th></tr></thead>
                <tbody>
                  ${c.materialRows.length ? c.materialRows.map((m, j) => materialRowHtml(m, j)).join('') : `<tr><td colspan="7" class="subtitle">No materials costed to this cost centre yet.</td></tr>`}
                  <tr><td colspan="6" style="text-align:right; font-weight:600;">Materials total</td><td class="num ia-material-total" style="font-weight:600; white-space:nowrap;"></td></tr>
                </tbody>
              </table>
            </div>`}
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
                    <td>${removeBtn('ia-item-remove')}</td>
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
        const bill = tr.querySelector('.ia-row-bill');
        if (bill) bill.addEventListener('change', (e) => {
          // The tick is per shift: a shift split into bands (or a person's rows in Flat) moves together.
          // Set on the clocked shifts themselves, since the rows are rebuilt from them (setting it on the
          // rows alone came straight back ticked).
          const ids = new Set(r.timeEntryIds);
          centres.forEach(cc => (cc.labourLines || []).forEach((l) => { if (ids.has(l.timeEntryId)) l.billable = e.target.checked; }));
          buildLabourRows();
          renderCentres();
        });
        const rm = tr.querySelector('.ia-row-remove');
        if (rm) rm.addEventListener('click', () => { c.labourRows.splice(Number(tr.dataset.lr), 1); renderCentres(); });
        const staffTier = tr.querySelector('.ia-staff-tier');
        if (staffTier) staffTier.addEventListener('change', (e) => {
          const t = rateTiers.find(x => x.id === e.target.value);
          if (!t) return;
          tierOverride[r.staffId] = t;
          centres.forEach(cc => cc.labourRows.forEach((x) => {
            if (x.source === 'shift' && x.staffId === r.staffId) { x.rateTierId = t.id; x.tierName = t.name; x.rate = r2(t.sellRate * (x.mult || 1)); }
          }));
          renderCentres();
        });
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
        c.labourRows.push({ key: `r${rowKey++}`, source: 'added', timeEntryIds: [], staffId: null, staffName: '', rateTierId: t.id, tierName: t.name, hours: 1, rate: t.sellRate, note: '', billable: true });
        renderCentres();
      });
      const bulk = box.querySelector('.ia-material');
      if (bulk) bulk.addEventListener('input', (e) => { c.material = parseFloat(e.target.value) || 0; refreshTotals(); });
      box.querySelectorAll('[data-mr]').forEach((tr) => {
        const m = c.materialRows[Number(tr.dataset.mr)];
        const sync = () => { tr.querySelector('.ia-mat-total').textContent = money(r2(m.quantity * m.unitPrice)); refreshTotals(); };
        tr.querySelector('.ia-mat-qty').addEventListener('input', (e) => { m.quantity = parseFloat(e.target.value) || 0; sync(); });
        tr.querySelector('.ia-mat-price').addEventListener('input', (e) => { m.unitPrice = parseFloat(e.target.value) || 0; sync(); });
        tr.querySelector('.ia-mat-bill').addEventListener('change', (e) => {
          m.billable = e.target.checked;
          c.materialRows.sort((a, b) => (a.billable === b.billable ? 0 : a.billable ? -1 : 1));
          renderCentres();
        });
      });
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
          const mat = materials.find(x => x.id === picked.id);
          c.items.push({ kind: 'material', materialId: picked.id, name: picked.name, quantity: picked.quantity, unitPrice: r2((Number(mat?.cost_price) || 0) * (1 + c.markupPercent / 100)) });
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

  // What this invoice bills, for the notes writer: materials and hand-added labour say what was
  // fitted; clocked rows only say who and when, so they are left out.
  const billedLines = () => centres.filter(c => c.include).flatMap(c => [
    `Cost centre: ${c.name}`,
    ...billedMaterials(c).map(m => `Material: ${m.description} x ${m.quantity}`),
    ...c.items.map(it => `Material: ${it.name} x ${it.quantity}`),
    ...c.labourRows.filter(r => r.source === 'added' && r.note).map(r => `Labour: ${r.note}`),
  ]).slice(0, 80);
  const notesWriteBtn = overlay.querySelector('#ia-notes-write-btn');
  loadJsOnce('/js/invoice-notes.js?v=3', () => typeof wireInvoiceNotesWrite === 'function')
    .then(() => wireInvoiceNotesWrite(overlay.querySelector('#ia-notes'), notesWriteBtn, overlay.querySelector('#ia-notes-msg'), () => ({ projectId: project.id, lines: billedLines() })))
    .catch(() => { notesWriteBtn.disabled = true; });

  overlay.querySelector('#ia-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ia-confirm-btn').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#ia-confirm-btn');
    const msg = overlay.querySelector('#ia-msg');
    const picked = centres.filter(c => c.include);
    if (!picked.length) { msg.innerHTML = `<div class="error-box">Tick at least one cost centre.</div>`; return; }
    const empty = picked.find(c => centreTotal(c) <= 0);
    if (empty) { msg.innerHTML = `<div class="error-box">${escapeHtml(empty.name)} has nothing to invoice. Enter an amount, add a line, or untick it.</div>`; return; }
    if (picked.some(c => c.items.some(it => !(it.quantity > 0)))) { msg.innerHTML = `<div class="error-box">Every added item needs a quantity.</div>`; return; }
    if (picked.some(c => billedLabour(c).some(r => !(r.hours > 0) || r.rate < 0))) { msg.innerHTML = `<div class="error-box">Every labour line needs hours and a rate. Untick Bill on a line you do not want to bill.</div>`; return; }
    if (materialMode === 'itemised' && picked.some(c => billedMaterials(c).some(m => !(m.quantity > 0) || m.unitPrice < 0))) { msg.innerHTML = `<div class="error-box">Every material line needs a quantity and a price. Untick Bill on a line you do not want to bill.</div>`; return; }

    const toClaim = (c) => ({
      costCentreId: c.costCentreId, labourAmount: 0, materialAmount: materialMode === 'bulk' ? (Number(c.material) || 0) : 0, claimPercent: null,
      items: [
        ...billedLabour(c).map(r => ({ kind: 'labour', staffId: r.staffId || null, rateTierId: r.rateTierId || null, timeEntryIds: r.timeEntryIds, quantity: r.hours, unitPrice: r.rate, description: rowDescription(r) })),
        ...(lessAmount(c) < 0 ? [{ kind: 'labour', quantity: 1, unitPrice: lessAmount(c), description: `Less: ${c.less.reason || 'adjustment'}` }] : []),
        ...(materialMode === 'itemised' ? billedMaterials(c).map(m => ({ kind: 'material', jobMaterialUsageId: m.usageId, materialId: m.materialId || null, quantity: m.quantity, unitPrice: m.unitPrice, description: m.description })) : []),
        ...c.items.map(it => ({ kind: it.kind, materialId: it.materialId || null, prebuildId: it.prebuildId || null, quantity: it.quantity, unitPrice: it.unitPrice })),
      ],
    });
    // The Bill ticks, saved on the job when the invoice is created (create-invoice.js).
    const marks = (list) => {
      const on = { timeEntryIds: [], usageIds: [] }, off = { timeEntryIds: [], usageIds: [] };
      list.forEach((c) => {
        c.labourRows.filter(r => r.source === 'shift').forEach(r => (r.billable === false ? off : on).timeEntryIds.push(...r.timeEntryIds));
        c.materialRows.forEach(m => (m.billable ? on : off).usageIds.push(m.usageId));
      });
      return { billable: on, notBillable: off };
    };
    const batches = mode === 'separate' ? picked.map(c => ({ claims: [toClaim(c)], ...marks([c]) })) : [{ claims: picked.map(toClaim), ...marks(picked) }];

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creating...';
    const created = [];
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      for (const batch of batches) {
        const res = await fetch('/.netlify/functions/create-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            projectId: project.id,
            ...batch,
            sentAt: overlay.querySelector('#ia-date').value || null,
            dueDate: overlay.querySelector('#ia-due-date').value || null,
            notes: overlay.querySelector('#ia-notes').value.trim() || null,
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
    msg.querySelectorAll('.ia-email-btn').forEach(b => b.addEventListener('click', () => loadInvoiceActions()
      .then(() => emailInvoiceToClient(b.dataset.id, project, { btn: b, msgEl: b.nextElementSibling }))
      .catch(err => { b.nextElementSibling.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; })));
    confirmBtn.style.display = 'none';
    overlay.querySelector('#ia-cancel-btn').textContent = 'Close';
    overlay.querySelector('#ia-cancel-btn').addEventListener('click', () => window.location.reload());
  });
}
