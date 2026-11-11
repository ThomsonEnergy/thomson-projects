// The staff-only side of the savings estimate (public/js/solar-roi.js), loaded by project.html after
// it and never by the client's proposal: the mistake checks shown on a quote's bill card and step 5,
// the working behind each figure, the coloured strip of a plan's times, and the plan finder's
// grouping by retailer. Everything here reads the estimate; nothing is saved. In the browser the
// estimate's own functions and constants are globals from solar-roi.js.

// ---------- mistake checks (staff only) ----------

// Figures that are allowed but usually mean something was typed or read wrong. Each says what to
// look at. Never shown to the customer and never blocks sending: they sit in the bill card's box
// and on step 5 so they are seen before the proposal goes out.
function roiChecks(argsIn) {
  const { reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, linesBatteryKwh, pylonStorage, money, est } = roiIncGstArgs(argsIn);
  const out = [];
  const fmt = money || ((n) => `$${Math.round(n).toLocaleString('en-AU')}`);
  const a = answers || {};
  const m = billMetrics(reading);
  const solar = roiNum(newSolarKw) || 0;
  const battery = roiNum(batteryKwh) || 0;
  const lines = roiNum(linesBatteryKwh) || 0;
  const total = roiNum(netCost) || 0;
  const sp = roiNum(solarPrice), bp = roiNum(batteryPrice);
  const add = (key, staff) => out.push({ key, staff });

  if (battery > 0 && (battery < ROI_ASSUMPTIONS.minBatteryKwh || battery > ROI_ASSUMPTIONS.maxBatteryKwh)) add('battery_range', `The battery quoted is ${battery} kWh. The federal discount covers batteries of 5 to 100 kWh usable: check the size under What we are quoting.`);
  if (lines > 0 && battery > 0 && Math.abs(battery - lines) / lines > 0.1) add('battery_lines', `The battery quoted is ${battery} kWh but the battery lines on the quote add up to ${lines} kWh: make them match (clear the box to use the line items).`);
  if (template === 'solar' && a.with_battery !== 'Yes' && lines > 0) add('battery_answer', `The quote has battery lines (${lines} kWh) but "Batteries as well?" is not Yes: answer it so the battery rules and the battery step apply.`);
  if (solar > 0 && (solar < 1.5 || solar > 100)) add('solar_range', `The solar size is ${solar} kW: check the System size on step 3.`);
  if (reading) {
    [['billing_days', 'The days on the bill'], ['total_kwh', 'The kWh used']].forEach(([k, label]) => { const n = roiNum(reading[k]); if (n != null && n <= 0) add(`${k}_zero`, `${label} must be more than 0: check what was typed or read.`); });
    if (m.days != null && (m.days < 20 || m.days > 100)) add('days', `The bill covers ${m.days} days: check the days were read right (a quarterly bill is about 90, a monthly one about 30).`);
    if (m.dailyKwh != null && m.dailyKwh < 3) add('tiny_use', `The bill works out at ${m.dailyKwh} kWh a day, which is very low: check the kWh and the days.`);
    const plan = roiPlan((inputs || {}).current, reading, 'Current plan');
    const rates = plan.tariff === 'tou' ? ROI_BANDS.filter(b => plan.rateKnown[b.key]).map(b => [b.label.toLowerCase(), plan[b.key]]) : [['usage', plan.rate]];
    rates.forEach(([name, v]) => { if (v != null && (v < (name === 'solar soak' ? 0 : 10) || v > 100)) add(`rate_${name}`, `The ${name} rate is ${v} c/kWh, outside the usual ${name === 'solar soak' ? 0 : 10} to 100: check it against the bill (cents, not dollars).`); });
    if (plan.supplyKnown && (plan.supply < 30 || plan.supply > 500)) add('supply', `The supply charge is ${plan.supply} c/day, outside the usual 30 to 500: check it against the bill (cents a day).`);
    const lowest = Math.min(...rates.filter(r => r[0] !== 'solar soak').map(r => r[1]).filter(v => v != null));
    if (plan.feedInKnown && Number.isFinite(lowest) && plan.feed_in >= lowest) add('feed_in', `The feed-in rate (${plan.feed_in} c/kWh) is as high as the rate you buy at: check it.`);
    if (plan.tariff === 'tou') {
      if (plan.timesFrom === 'assumed') add('tou_times', `The bill does not say when each rate applies, so this is assumed: ${roiScheduleText(plan)}. Type the times from the bill or the retailer's plan under When each rate applies (off-peak is often the middle of the day or the weekend too, not only overnight).`);
      if (plan.overlaps.length) {
        const o = plan.overlaps[0];
        add('tou_overlap', `Some hours are in two windows (for example ${String(o.h).padStart(2, '0')}:00 on ${ROI_DAY_KINDS[o.dk].label.toLowerCase()} is ${o.bands.map(b => ROI_BAND_LABEL[b].toLowerCase()).join(' and ')}): the narrower window is used. Check the times.`);
      }
      ROI_BANDS.forEach(b => {
        const used = (plan.bandShare[b.key] || 0) > 0;
        if (used && !plan.rateKnown[b.key] && b.key !== 'peak') add(`rate_missing_${b.key}`, `${b.label} applies at some times but has no rate on the bill: type its rate (${plan[b.key]} c/kWh is assumed).`);
        if (!used && plan.rateKnown[b.key]) add(`rate_unused_${b.key}`, `The ${b.label.toLowerCase()} rate is ${plan[b.key]} c/kWh but no time uses it: add its times, or make it "any other time".`);
      });
    }
  }
  const stalePlans = ((inputs || {}).plan_options || []).filter(o => o.fetched_at && Date.now() - new Date(o.fetched_at).getTime() > 30 * 86400000);
  if (stalePlans.length) add('plans_stale', `${stalePlans.length === 1 ? 'A plan option on the proposal is' : `${stalePlans.length} plan options on the proposal are`} more than 30 days old: find plans again and tick them again, or remove them.`);
  if (sp != null && bp != null && total > 0 && Math.abs(sp + bp - total) > Math.max(50, total * 0.01)) add('prices', `Solar ${fmt(sp)} plus battery ${fmt(bp)} is ${fmt(sp + bp)}, but the quote's total after credits is ${fmt(total)}: check the two prices.`);
  else if (total > 0 && ((sp != null && sp > total + 1) || (bp != null && bp > total + 1))) add('prices', `A price under What we are quoting is more than the whole quote (${fmt(total)} after credits): check it.`);
  if (est && est.current && est.batteryKwh > 0) {
    const f = est.current.stages.full;
    if (f.spareFill != null && f.spareFill < 0.7) add('solar_fill', `Spare solar fills the ${est.batteryKwh} kWh battery to only about ${Math.round(f.spareFill * 100)}% on an average day (enough to fill it on ${Math.round(f.spareFullDays * 100)}% of days). ${est.gridCharge ? 'Charging it at night tops it up (included in the figures).' : 'Options: more solar, a smaller battery, or charging it at night on a cheap rate (under More: Charge the battery from the grid).'}`);
    if (est.gridCharge && !f.gridCharged) add('grid_charge_unused', `Charging the battery from the grid ${est.gridCharge.rate != null ? `at ${est.gridCharge.rate} c/kWh` : 'at the plan\'s rate'} does not pay here: after battery losses it costs more than the power it would replace, so the figures leave it out.`);
  }
  if (est && est.current) {
    const c = est.current;
    const genExtra = c.stages.solar.generation - c.stages.base.generation;
    if (solar > 0 && est.home.useKwh && genExtra > est.home.useKwh * 2.5) add('oversized', `The solar makes about ${Math.round(genExtra / est.home.useKwh * 10) / 10} times what the home uses in a year: check the size, or expect most of it to be exported.`);
    if (c.paybackRaw != null && (c.paybackRaw < 1 || c.paybackRaw > ROI_ASSUMPTIONS.paybackCapYears)) add('payback', c.paybackRaw > ROI_ASSUMPTIONS.paybackCapYears ? `${ROI_NOT_PAID_OFF} (about ${c.paybackRaw} years at this saving), which is what the proposal says: check the price, the sizes and the rates.` : `Pays for itself in ${c.paybackRaw} years, which is unusual: check the price, the sizes and the rates.`);
    if (c.billNowIsActual && c.modelledNow > 0) {
      const diff = (c.modelledNow - c.billNow) / c.billNow;
      if (Math.abs(diff) > 0.2) add('model_vs_bill', `These rates on this use come to ${fmt(c.modelledNow)} a year but the bill says ${fmt(c.billNow)} (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%): check the rates, the supply charge and the kWh split, or a discount on the bill.`);
    }
  }
  // the battery against the Pylon design, when its models say their size
  const pylon = roiPylonBatteryKwh(pylonStorage);
  if (battery > 0 && pylon.kwh > 0 && Math.abs(battery - pylon.kwh) / pylon.kwh > 0.25) add('battery_pylon', `The battery quoted is ${battery} kWh but the Pylon design has ${pylon.text} (about ${pylon.kwh} kWh): make them match, the proposal shows both.`);
  if (est && est.current) {
    const full = est.current.stages.full;
    if (est.batteryKwh > 0 && full.discharged > 0 && full.discharged / 365 < est.batteryKwh * 0.6) add('battery_big', `On an average day the home takes about ${Math.round(full.discharged / 365)} kWh from the ${est.batteryKwh} kWh battery (${Math.round(100 * full.discharged / 365 / est.batteryKwh)}% of it): in these figures a smaller battery saves the same. Fine if the size is for backup; otherwise check the battery kWh.`);
    if (est.exportLimitKw != null && full.generation > 0 && full.curtailed / full.generation > 0.05) add('export_limit', `The ${est.exportLimitKw} kW export limit throws away about ${roiKwh(full.curtailed)} a year (${Math.round(100 * full.curtailed / full.generation)}% of what the panels make). The figures allow for it: check the limit is right.`);
    if (est.existingRemoved && (inputs || {}).existing_removed !== true) add('existing_removed', `The existing ${est.existingKw} kW system is taken as coming off the roof (from the words in the existing system answer), so it is not counted after the install. If it is staying, take "removed" out of that answer.`);
  }
  return out;
}

// The battery in a Pylon design, in kWh, when every storage model says its size ("SigenStor BAT
// 10.0", "Powerwall 13.5 kWh"): { kwh, text }. kwh is 0 when any model does not say.
function roiPylonBatteryKwh(storage) {
  const items = (storage || []).filter(m => m && m.description);
  let kwh = 0;
  for (const item of items) {
    const m = String(item.description).match(/(\d+(?:\.\d+)?)\s*kwh/i) || String(item.description).match(/\bBAT[\s-]*(\d+(?:\.\d+)?)/i);
    if (!m) return { kwh: 0, text: '' };
    kwh += parseFloat(m[1]) * (roiNum(item.quantity) || 1);
  }
  return { kwh: Math.round(kwh * 10) / 10, text: items.map(i => `${roiNum(i.quantity) || 1} x ${i.description}`).join(', ') };
}

// The working for the staff: each stage's kWh and dollars on each plan, as rows.
function roiWorkingRows(est, money) {
  if (!est) return [];
  const out = [];
  est.scenarios.forEach(s => {
    const plan = s.plan;
    const rateText = plan.tariff === 'tou' ? ROI_BANDS.filter(b => (plan.bandShare[b.key] || 0) > 0).map(b => `${b.label.toLowerCase()} ${plan[b.key]}`).join(', ') + ' c/kWh' : `${plan.rate} c/kWh`;
    out.push({ title: `${s.name}: ${rateText}, supply ${plan.supply} c/day, feed-in ${plan.feed_in} c/kWh`, rows: [] });
    const rows = out[out.length - 1].rows;
    if (plan.tariff === 'tou') rows.push(['When', `${roiScheduleText(plan)}${plan.timesFrom === 'assumed' ? ' (assumed: not on the bill)' : plan.timesFrom === 'typed' ? ' (typed)' : ' (from the bill)'}`]);
    const stages = [['As the home is now', s.stages.base], ...(est.newSolarKw > 0 ? [['With the solar', s.stages.solar]] : []), ...(est.batteryKwh > 0 ? [['With the solar and the battery', s.stages.full]] : [])];
    stages.forEach(([label, st]) => {
      const imp = Object.entries(st.importBy).filter(([, v]) => v > 0).map(([b, v]) => `${plan.bandLabel[b].toLowerCase()} ${roiKwh(v)} (${money(st.costBy[b])})`).join(', ');
      rows.push([label, `${st.solarKw ? `${st.solarKw} kW makes ${roiKwh(st.generation)}; ` : ''}used straight ${roiKwh(st.selfUse)}${st.batteryKwh ? `; battery charged ${roiKwh(st.charged)}, gave back ${roiKwh(st.discharged)}${plan.tariff === 'tou' ? ` (${Object.entries(st.dischargedBy).filter(([, v]) => v > 0).map(([b, v]) => `${plan.bandLabel[b].toLowerCase()} ${roiKwh(v)}`).join(', ')})` : ''}${st.batteryExport ? `, sold ${roiKwh(st.batteryExport)} at ${st.exportRate} c` : ''}${st.gridCharging ? `, charged from the grid ${roiKwh(st.gridCharged)}` : ''}; spare solar fills about ${Math.round((st.spareFill || 0) * 100)}% of it on an average day` : ''}; exported ${roiKwh(st.exported)}${st.curtailed ? `, lost to the export limit ${roiKwh(st.curtailed)}` : ''}; bought ${imp || '0 kWh'}${st.controlledKwh ? `; controlled load ${roiKwh(st.controlledKwh)}` : ''}. Bill: usage ${money(st.usageCost)}${st.controlledCost ? ` + controlled ${money(st.controlledCost)}` : ''} + supply ${money(st.supplyCost)} - feed-in ${money(st.feedInCredit)}${st.batteryExportCredit ? ` - battery sales ${money(st.batteryExportCredit)}` : ''}${st.gridChargeCost ? ` + battery charging ${money(st.gridChargeCost)}` : ''} = ${money(st.bill)} a year`]);
    });
    if (s.gridChargeAdds != null) rows.push(['Night charging', `On spare solar alone the battery would save ${money(s.batterySaving - s.gridChargeAdds)} a year; charging at night as well adds ${money(s.gridChargeAdds)}.`]);
    if (s.billNowIsActual && s.modelledNow) {
      const diff = Math.round(100 * (s.modelledNow - s.billNow) / s.billNow);
      rows.push(['Check', `The bill says ${money(s.billNow)} a year; these rates on this usage give ${money(s.modelledNow)} (${diff > 0 ? '+' : ''}${diff}%).${Math.abs(diff) > 20 ? ' More than 20% apart: check the rates, the times, the split and the controlled load.' : ''}`]);
    }
  });
  return out;
}

// A coloured strip per day pattern (24 cells, one per hour) so the times can be seen at a glance.
function roiScheduleStripHtml(plan) {
  if (plan.tariff !== 'tou') return '';
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const color = Object.fromEntries(ROI_BANDS.map(b => [b.key, b.color]));
  const groups = roiDayPatterns(plan);
  const ticks = `<div style="display:flex; justify-content:space-between; font-size:10.5px; opacity:0.7; margin-top:2px;"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>`;
  // the label sits beside the strip on a wide screen and above it on a phone
  const rows = groups.map((g, gi) => `
    <div style="display:flex; flex-wrap:wrap; align-items:center; column-gap:8px; margin:4px 0;">
      <div style="flex:1 1 110px; font-size:12px;">${esc(g.label)}</div>
      <div style="flex:4 1 220px; min-width:0;">
        <div style="display:flex; gap:1px;">${g.row.map((b, h) => `<div title="${String(h).padStart(2, '0')}:00 ${esc(ROI_BAND_LABEL[b])}" style="flex:1; height:16px; background:${color[b] || '#9ca3af'}; ${h === 0 ? 'border-radius:3px 0 0 3px;' : h === 23 ? 'border-radius:0 3px 3px 0;' : ''}"></div>`).join('')}</div>
        ${gi === groups.length - 1 ? ticks : ''}
      </div>
    </div>`).join('');
  const used = ROI_BANDS.filter(b => plan.grid.some(rs => rs.some(row => row.includes(b.key))));
  const legend = `<div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:6px; font-size:12px;">${used.map(b => `<span style="display:inline-flex; align-items:center; gap:5px;"><span style="width:12px; height:12px; border-radius:3px; background:${b.color};"></span>${esc(b.label)}${plan[b.key] != null ? ` ${esc(plan[b.key])} c/kWh` : ''}</span>`).join('')}</div>`;
  return `<div class="roi-strip">${rows}${legend}</div>`;
}

// The plan list staff pick from: one group per retailer, in the order of its cheapest plan for this
// home, so a retailer with many near-identical plans cannot fill the list. rows are roiComparePlans
// rows (cheapest with the system first); brandOf(key) and nameOf(key) name the retailer and the plan
// (the caller adds the tariff type to the name, so a flat and a time-of-use plan of one name both stay).
// Returns [{ brand, best, more }]: `more` is that retailer's other plans, the cheapest of each name.
function roiPlansByRetailer(rows, brandOf, nameOf) {
  const groups = new Map();
  (rows || []).forEach(r => {
    const brand = String(brandOf(r.key) || 'Other').trim();
    const name = String(nameOf(r.key) || '').trim();
    const g = groups.get(brand);
    if (!g) { groups.set(brand, { brand, best: r, more: [], names: new Set([name]) }); return; }
    if (g.names.has(name)) return; // a dearer variant of a plan already listed
    g.names.add(name);
    g.more.push(r);
  });
  return [...groups.values()].map(g => ({ brand: g.brand, best: g.best, more: g.more }));
}
