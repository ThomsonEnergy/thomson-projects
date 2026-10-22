// Solar and battery sizing plus the return on investment figures shown on a
// proposal. One file shared by the browser (quote page, proposal) and the
// functions (read-electricity-bill.js), so the staff preview and what the
// client sees are the same maths. Plain script plus the module.exports guard
// at the bottom: no DOM access at load time.
//
// Inputs come from the AI reading of the customer's electricity bill
// (projects.bill_reading, see docs/IDEAS_BACKLOG.md item 29) plus the quote's
// system size, battery size and net price. Every figure is an estimate from
// the assumptions below; the proposal says so.

const ROI_ASSUMPTIONS = {
  // kWh generated per kW of panels per day, by STC zone rating (Clean Energy Council guide figures).
  yieldPerKwPerDay: { 1.622: 4.4, 1.536: 4.2, 1.382: 3.9, 1.185: 3.5 },
  defaultZoneRating: 1.382,
  // Share of a home's use that falls in daylight hours when the bill gives no time-of-use split.
  daytimeShare: 0.40,
  batteryRoundTrip: 0.90,     // kWh out per kWh in
  batteryUsableCycle: 0.85,   // share of usable capacity cycled on an average day
  // Cloudy weeks and winter keep a home on the grid some of the time: these cap how much of the
  // daytime use the panels cover and how much of the evening use the battery covers over a year.
  daytimeCoverCap: 0.90,
  eveningCoverCap: 0.80,
  priceRisePerYear: 0.03,     // electricity price growth used for the 10 and 25 year figures
  panelDegradationPerYear: 0.005,
  gridEmissionsKgPerKwh: 0.68, // NSW grid average
  defaultUsageRateCents: 33,
  defaultFeedInCents: 5,
  defaultSupplyChargeCents: 110,
  solarSizesKw: [6.6, 8, 10, 13.2, 15, 20, 26.6, 30],
  batterySizesKwh: [5, 10, 13.5, 16, 20, 25, 30, 40, 50],
  minBatteryKwh: 5,
  maxBatteryKwh: 100,
};

function roiNum(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function roiRoundUpTo(value, sizes) {
  for (const s of sizes) if (s >= value - 0.001) return s;
  return sizes[sizes.length - 1];
}

// The daily and yearly figures from a bill reading. Works from whatever the reading has:
// total kWh and days, or a daily average, or nothing (then null everywhere).
function billMetrics(reading) {
  const r = reading || {};
  const days = roiNum(r.billing_days);
  const totalKwh = roiNum(r.total_kwh);
  let dailyKwh = roiNum(r.daily_average_kwh);
  if (!dailyKwh && totalKwh && days) dailyKwh = totalKwh / days;
  const billTotal = roiNum(r.bill_total);
  const annualBill = billTotal && days ? billTotal * 365 / days : null;
  const peak = roiNum(r.peak_kwh), shoulder = roiNum(r.shoulder_kwh), offPeak = roiNum(r.off_peak_kwh), controlled = roiNum(r.controlled_load_kwh);
  const split = (peak || shoulder || offPeak) ? { peak: peak || 0, shoulder: shoulder || 0, offPeak: offPeak || 0, controlled: controlled || 0 } : null;
  const usageRate = roiNum(r.usage_rate_c_per_kwh) || ROI_ASSUMPTIONS.defaultUsageRateCents;
  const feedIn = roiNum(r.feed_in_c_per_kwh);
  const supplyCharge = roiNum(r.supply_charge_c_per_day) || ROI_ASSUMPTIONS.defaultSupplyChargeCents;
  const exportKwh = roiNum(r.solar_export_kwh);
  return {
    days, totalKwh, dailyKwh: dailyKwh ? Math.round(dailyKwh * 10) / 10 : null,
    annualKwh: dailyKwh ? Math.round(dailyKwh * 365) : null,
    billTotal, annualBill: annualBill ? Math.round(annualBill) : null,
    split, usageRate, feedIn: feedIn == null ? ROI_ASSUMPTIONS.defaultFeedInCents : feedIn, feedInFromBill: feedIn != null,
    supplyCharge, exportKwh,
    hasSolarAlready: !!(exportKwh && exportKwh > 0),
  };
}

// Share of use outside daylight: the off-peak plus shoulder share where the bill splits it
// (peak is the evening on most NSW tariffs, so evening = peak + off-peak), else the default.
function eveningShare(metrics) {
  if (!metrics.split) return 1 - ROI_ASSUMPTIONS.daytimeShare;
  const total = metrics.split.peak + metrics.split.shoulder + metrics.split.offPeak;
  if (!total) return 1 - ROI_ASSUMPTIONS.daytimeShare;
  const share = (metrics.split.peak + metrics.split.offPeak) / total;
  return Math.min(0.85, Math.max(0.45, share));
}

function existingSolarKw(answers) {
  const a = answers || {};
  const text = `${a.existing_system_detail || ''} ${a.existing_pv || ''}`;
  const m = text.match(/(\d+(?:\.\d+)?)\s*kw/i);
  if (m) return parseFloat(m[1]);
  return 0;
}

// Suggested solar kW and battery kWh from the bill and the pre-quote answers. Deterministic.
function suggestSizes({ reading, answers, zoneRating }) {
  const m = billMetrics(reading);
  const a = answers || {};
  const yieldPerKw = ROI_ASSUMPTIONS.yieldPerKwPerDay[zoneRating] || ROI_ASSUMPTIONS.yieldPerKwPerDay[ROI_ASSUMPTIONS.defaultZoneRating];
  const existingKw = existingSolarKw(a);
  const notes = [];
  let solarKw = null, solarRaw = null;
  if (m.dailyKwh) {
    solarRaw = m.dailyKwh / yieldPerKw;
    const wanted = Math.max(0, solarRaw - existingKw);
    solarKw = wanted > 0 ? roiRoundUpTo(wanted, ROI_ASSUMPTIONS.solarSizesKw) : 0;
    notes.push(`${m.dailyKwh} kWh a day divided by ${yieldPerKw} kWh per kW per day = ${solarRaw.toFixed(1)} kW to cover the whole year's use${existingKw ? `, less ${existingKw} kW already on the roof` : ''}, rounded up to a common size.`);
    if (a.export_limit && /zero|5 kw/i.test(a.export_limit)) notes.push(`Export limit "${a.export_limit}": a bigger system mostly feeds a battery, not the grid.`);
  }
  let batteryKwh = null, eveningKwh = null;
  if (m.dailyKwh) {
    const share = eveningShare(m);
    eveningKwh = m.dailyKwh * share;
    let wanted = eveningKwh / ROI_ASSUMPTIONS.batteryUsableCycle;
    const backup = String(a.backup_needs || '').toLowerCase();
    if (backup && !/^(nothing|none|no)\b/.test(backup) && /pump|air|aircon|ducted|whole|everything|all/.test(backup)) {
      wanted *= 1.25;
      notes.push('Backup needs include heavy loads, so the battery is sized a quarter larger.');
    }
    batteryKwh = Math.min(ROI_ASSUMPTIONS.maxBatteryKwh, Math.max(ROI_ASSUMPTIONS.minBatteryKwh, roiRoundUpTo(wanted, ROI_ASSUMPTIONS.batterySizesKwh)));
    notes.push(`${Math.round(share * 100)}% of use is outside daylight (${eveningKwh.toFixed(1)} kWh a day${m.split ? ', from the bill\'s peak and off-peak split' : ', assumed'}), rounded up to a common battery size within the 5 to 100 kWh federal discount band.`);
  }
  return {
    solarKw, solarRawKw: solarRaw ? Math.round(solarRaw * 10) / 10 : null, existingKw, yieldPerKw,
    batteryKwh, eveningKwhPerDay: eveningKwh ? Math.round(eveningKwh * 10) / 10 : null,
    dailyKwh: m.dailyKwh, notes,
  };
}

// One scenario: a home with `solarKw` of panels and `batteryKwh` of battery against the bill's use.
function roiScenario(m, solarKw, batteryKwh, yieldPerKw) {
  const annualUse = m.annualKwh || 0;
  const generation = (solarKw || 0) * yieldPerKw * 365;
  const daytimeUse = annualUse * (1 - eveningShare(m));
  const eveningUse = annualUse - daytimeUse;
  const selfUseDay = Math.min(generation, daytimeUse * ROI_ASSUMPTIONS.daytimeCoverCap);
  let surplus = generation - selfUseDay;
  let shifted = 0;
  if (batteryKwh > 0 && surplus > 0) {
    const batteryPerYear = batteryKwh * ROI_ASSUMPTIONS.batteryUsableCycle * 365;
    shifted = Math.min(surplus * ROI_ASSUMPTIONS.batteryRoundTrip, batteryPerYear, eveningUse * ROI_ASSUMPTIONS.eveningCoverCap);
    surplus -= shifted / ROI_ASSUMPTIONS.batteryRoundTrip;
  }
  const exported = Math.max(0, surplus);
  const selfUse = selfUseDay + shifted;
  const savings = selfUse * m.usageRate / 100 + exported * m.feedIn / 100;
  return { generation, selfUse, exported, shifted, savings, selfUseShare: generation ? selfUse / generation : 0, gridKwh: Math.max(0, annualUse - selfUse) };
}

// The figures for the proposal. `newSolarKw` is what this quote installs (0 on a battery-only
// quote), `batteryKwh` the battery it installs, `netCost` the total inc GST after the credits.
// The saving is the proposed system against what the home has now (existing solar, no battery).
function roiFor({ reading, answers, newSolarKw, batteryKwh, netCost, zoneRating }) {
  const m = billMetrics(reading);
  if (!m.annualKwh) return null;
  const yieldPerKw = ROI_ASSUMPTIONS.yieldPerKwPerDay[zoneRating] || ROI_ASSUMPTIONS.yieldPerKwPerDay[ROI_ASSUMPTIONS.defaultZoneRating];
  const existingKw = existingSolarKw(answers);
  const solar = roiNum(newSolarKw) || 0;
  const battery = roiNum(batteryKwh) || 0;
  if (!solar && !battery) return null;
  const before = roiScenario(m, existingKw, 0, yieldPerKw);
  const after = roiScenario(m, existingKw + solar, battery, yieldPerKw);
  const annualSaving = Math.max(0, after.savings - before.savings);
  const supplyPerYear = m.supplyCharge * 365 / 100;
  // the bill now: from the bill itself when it has a total, else rebuilt from use and rates
  const annualBillNow = m.annualBill != null ? m.annualBill : Math.round(annualUseCost(m) - before.savings + supplyPerYear);
  const annualBillAfter = Math.max(Math.round(supplyPerYear - (after.exported * m.feedIn / 100)), Math.round(annualBillNow - annualSaving));
  const cost = roiNum(netCost) || 0;
  const payback = annualSaving > 0 && cost > 0 ? cost / annualSaving : null;
  const over = (years) => {
    let sum = 0;
    for (let y = 0; y < years; y++) sum += annualSaving * Math.pow(1 + ROI_ASSUMPTIONS.priceRisePerYear, y) * Math.pow(1 - ROI_ASSUMPTIONS.panelDegradationPerYear, y);
    return Math.round(sum);
  };
  const cumulative = [];
  for (let y = 0; y <= 25; y++) cumulative.push(over(y));
  const co2Tonnes = (after.selfUse - before.selfUse + after.exported - before.exported) * ROI_ASSUMPTIONS.gridEmissionsKgPerKwh / 1000;
  return {
    dailyKwh: m.dailyKwh, annualKwh: m.annualKwh, usageRate: m.usageRate, feedIn: m.feedIn, feedInFromBill: m.feedInFromBill,
    existingKw, newSolarKw: solar, batteryKwh: battery, yieldPerKw,
    generationKwh: Math.round(after.generation - before.generation),
    selfUseKwh: Math.round(after.selfUse), exportedKwh: Math.round(after.exported), shiftedKwh: Math.round(after.shifted),
    selfUseShare: Math.round(after.selfUseShare * 100), gridKwhAfter: Math.round(after.gridKwh),
    gridShareAfter: m.annualKwh ? Math.round(100 * (1 - after.gridKwh / m.annualKwh)) : 0,
    annualBillNow, annualBillAfter, annualSaving: Math.round(annualSaving),
    netCost: cost, paybackYears: payback ? Math.round(payback * 10) / 10 : null,
    saving10: over(10), saving25: over(25), cumulative, co2TonnesPerYear: Math.round(co2Tonnes * 10) / 10,
    annualReturnPercent: cost > 0 ? Math.round(annualSaving / cost * 1000) / 10 : null,
  };
}

// What is missing for an honest savings estimate. A `blocking` gap keeps every figure off the
// proposal: it asks the customer for what it needs (the `client` text) instead of showing numbers
// built on defaults. Gaps with no client text are the staff's to fix (size, price). The rest are
// warnings only: the figures show, with the assumption declared.
function roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost }) {
  const gaps = [];
  const a = answers || {};
  const r = reading || null;
  const m = billMetrics(r);
  const hasBattery = template === 'battery' || (template === 'solar' && a.with_battery === 'Yes');
  if (!r) {
    gaps.push({ key: 'bill', blocking: true, staff: 'No electricity bill read yet: add every page above and press Read bill with AI.', client: 'a recent electricity bill, every page, so we can see how much power you use and what you pay for it' });
  } else {
    if (!m.dailyKwh) gaps.push({ key: 'usage', blocking: true, staff: 'The bill gives no usage in kWh (no total kWh with the number of days, and no daily average).', client: 'the page of your bill with the usage table (kWh used and the number of days in the period)' });
    if (roiNum(r.usage_rate_c_per_kwh) == null) gaps.push({ key: 'rate', blocking: true, staff: `No usage rate (c/kWh) on the bill; the preview assumes ${ROI_ASSUMPTIONS.defaultUsageRateCents} c/kWh.`, client: 'the page of your bill that shows your rates (cents per kWh, and the daily supply charge)' });
    if (roiNum(r.bill_total) == null) gaps.push({ key: 'total', blocking: true, staff: 'No bill total found; the preview rebuilds a yearly bill from use and rates.', client: 'the page of your bill with the total amount for the period' });
    if (m.days && m.days < 28) gaps.push({ key: 'short', blocking: false, staff: `A ${m.days} day bill: the yearly figures are scaled up from it. A full quarterly bill is better.`, client: 'a full quarterly bill if you have one (the one we have covers only a short period)' });
    if ((m.hasSolarAlready || template === 'battery') && !existingSolarKw(a)) gaps.push({ key: 'existing', blocking: true, staff: `${template === 'battery' ? 'A battery quote' : 'The bill shows solar export'} but no existing solar size in the answers (Existing system details or Existing PV size, in kW).`, client: 'the size of your existing solar system in kW (on the inverter label or your original paperwork)' });
    if (roiNum(r.supply_charge_c_per_day) == null) gaps.push({ key: 'supply', blocking: false, staff: `No daily supply charge on the bill; ${ROI_ASSUMPTIONS.defaultSupplyChargeCents} c/day assumed.`, client: null });
    if (!m.split) gaps.push({ key: 'tou', blocking: false, staff: `No time-of-use split on the bill: ${Math.round((1 - ROI_ASSUMPTIONS.daytimeShare) * 100)}% of use assumed to be outside daylight.`, client: null });
  }
  if (template !== 'battery' && !(roiNum(newSolarKw) > 0)) gaps.push({ key: 'size', blocking: true, staff: 'No system size: set it on step 3 (STC system size) or pull the Pylon design.', client: null });
  if (hasBattery && !(roiNum(batteryKwh) > 0)) gaps.push({ key: 'battery', blocking: true, staff: 'No battery size: answer "Usable kWh wanted" on step 1.', client: null });
  if (!(roiNum(netCost) > 0)) gaps.push({ key: 'price', blocking: true, staff: 'No price yet: the payback needs a priced stage on step 3.', client: null });
  return gaps;
}

function annualUseCost(m) {
  return (m.annualKwh || 0) * m.usageRate / 100;
}

// Rows for a savings table (proposal and the quote page preview). money() is the caller's formatter.
// opts.dollars false leaves out every dollar row (the bill gave no rates or total: the kWh figures
// stand, the money ones wait for the missing page); opts.billsNow false leaves out "Your bills now".
function roiRows(roi, money, opts = {}) {
  if (!roi) return [];
  const dollars = opts.dollars !== false;
  const kwh = (n) => `${Math.round(n).toLocaleString('en-AU')} kWh`;
  const rows = [['Your use now', `${kwh(roi.annualKwh)} a year (${roi.dailyKwh} kWh a day)`]];
  if (dollars && opts.billsNow !== false) rows.push(['Your bills now', `${money(roi.annualBillNow)} a year`]);
  if (roi.newSolarKw) rows.push(['Solar generated', `${kwh(roi.generationKwh)} a year from ${roi.newSolarKw} kW of panels`]);
  if (roi.batteryKwh) rows.push(['Stored for the evening', `${kwh(roi.shiftedKwh)} a year through the ${roi.batteryKwh} kWh battery`]);
  rows.push(['Used at home', `${kwh(roi.selfUseKwh)} a year (${roi.selfUseShare}% of what the system makes)`]);
  rows.push(['Sent to the grid', `${kwh(roi.exportedKwh)} a year at ${roi.feedIn} c/kWh`]);
  rows.push(['Bought from the grid after', `${kwh(roi.gridKwhAfter)} a year (${roi.gridShareAfter}% less than now)`]);
  if (dollars) {
    if (opts.billsNow !== false) rows.push(['Estimated bills after', `${money(roi.annualBillAfter)} a year`]);
    rows.push(['Estimated saving', `${money(roi.annualSaving)} a year`]);
    if (roi.netCost) rows.push(['Your investment', `${money(roi.netCost)} after the credits`]);
    if (roi.paybackYears) rows.push(['Pays for itself in', `${roi.paybackYears} years`]);
    if (roi.annualReturnPercent) rows.push(['Yearly return', `${roi.annualReturnPercent}% of the investment`]);
    rows.push(['Saving over 10 years', money(roi.saving10)]);
    rows.push(['Saving over 25 years', money(roi.saving25)]);
  }
  rows.push(['Emissions avoided', `about ${roi.co2TonnesPerYear} tonnes of CO2 a year`]);
  return rows;
}

// What a missing piece would give the customer once we have it (the "to give you Y we need X" line).
const ROI_GAP_GIVES = {
  bill: 'your yearly saving, how soon the system pays for itself and the 10 and 25 year savings',
  usage: 'any savings figures',
  rate: 'the dollar savings, how soon the system pays for itself and the 10 and 25 year savings',
  total: 'your bills before and after, and the dollar savings',
  existing: 'the generation and savings figures for your home',
  short: 'a more accurate yearly figure',
};

// Everything the proposal (and the quote page preview) shows for the savings estimate: the rows we
// can stand behind with what we have, the asks ("to give you Y, we need X") for what the customer
// can supply, and the staff-side gaps. Nothing is withheld that we do have; nothing is shown that
// rests on a guess: no rates or total on the bill means kWh rows only, no existing solar size when
// the bill shows export means use and bills only, no system size means no generation.
function roiPresentation({ reading, answers, template, newSolarKw, batteryKwh, netCost, zoneRating, money }) {
  const gaps = roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost });
  const has = (k) => !gaps.some(g => g.key === k);
  const m = billMetrics(reading);
  const asks = gaps.filter(g => g.client).map(g => ({ key: g.key, need: g.client, gives: ROI_GAP_GIVES[g.key] || 'a more accurate estimate', blocking: g.blocking }));
  let roi = null;
  let rows = [];
  if (reading && m.dailyKwh) {
    const dollars = has('rate') && has('total');
    const canModel = has('existing') && ((roiNum(newSolarKw) || 0) > 0 || (roiNum(batteryKwh) || 0) > 0);
    if (canModel) {
      roi = roiFor({ reading, answers, newSolarKw, batteryKwh, netCost, zoneRating });
      rows = roiRows(roi, money, { dollars, billsNow: has('total') });
    } else {
      rows = [['Your use now', `${Math.round(m.annualKwh).toLocaleString('en-AU')} kWh a year (${m.dailyKwh} kWh a day)`]];
      if (has('total') && m.annualBill) rows.push(['Your bills now', `${money(m.annualBill)} a year`]);
    }
  }
  return { roi, rows, asks, gaps, metrics: m, dollars: !!roi && has('rate') && has('total') };
}

// Three small pictures for the proposal and the quote page preview, as inline SVG so the PDF
// gets them too: the yearly bill now and after, where the home's power will come from, and the
// savings adding up against the investment. Kept plain: a few marks, direct labels, one colour
// per thing (solar blue, battery green, grid grey as the neutral remainder). Only drawn when the
// dollar figures stand (roi with rates and a total); the power chart alone when they do not.
const ROI_CHART_COLORS = { solar: '#1a6be6', battery: '#15803d', grid: '#5b6472', ink: '#0a0a0a', muted: '#5b6472', line: '#d9dde5' };

function roiChartsHtml(roi, money, { dollars = true, colors = ROI_CHART_COLORS } = {}) {
  if (!roi) return '';
  const c = colors;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const font = `font-family: Archivo, Helvetica, Arial, sans-serif;`;
  const charts = [];

  if (dollars) {
    // 1. Your yearly bill: two bars.
    const now = roi.annualBillNow, after = roi.annualBillAfter;
    const max = Math.max(now, after, 1);
    const h = (v) => Math.max(2, Math.round(110 * v / max));
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Your yearly bill</figcaption>
        <svg viewBox="0 0 220 170" width="100%" role="img" aria-label="Yearly bill now ${esc(money(now))}, with the system ${esc(money(after))}">
          <line x1="20" y1="140" x2="200" y2="140" stroke="${c.line}" stroke-width="1" />
          <rect x="45" y="${140 - h(now)}" width="50" height="${h(now)}" rx="4" fill="${c.grid}" />
          <rect x="125" y="${140 - h(after)}" width="50" height="${h(after)}" rx="4" fill="${c.solar}" />
          <text x="70" y="${140 - h(now) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${c.ink}" style="${font}">${esc(money(now))}</text>
          <text x="150" y="${140 - h(after) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${c.ink}" style="${font}">${esc(money(after))}</text>
          <text x="70" y="158" text-anchor="middle" font-size="11" fill="${c.muted}" style="${font}">Now</text>
          <text x="150" y="158" text-anchor="middle" font-size="11" fill="${c.muted}" style="${font}">With the system</text>
        </svg>
      </figure>`);
  }

  // 2. Where your power will come from: one stacked bar, three parts.
  const use = Math.max(roi.annualKwh, 1);
  const parts = [
    { key: 'solar', label: 'Straight from the solar', kwh: Math.max(0, roi.selfUseKwh - roi.shiftedKwh), color: c.solar },
    { key: 'battery', label: 'From the battery at night', kwh: roi.shiftedKwh, color: c.battery },
    { key: 'grid', label: 'Still from the grid', kwh: roi.gridKwhAfter, color: c.grid },
  ].filter(p => p.kwh > 0);
  let x = 10;
  const W = 200;
  const segs = parts.map((p, i) => {
    const w = Math.max(0, Math.round(W * p.kwh / use) - (i < parts.length - 1 ? 2 : 0));
    const out = `<rect x="${x}" y="30" width="${w}" height="28" rx="${i === 0 || i === parts.length - 1 ? 4 : 0}" fill="${p.color}" />`;
    x += w + 2;
    return out;
  }).join('');
  const legend = parts.map((p, i) => `<g transform="translate(10, ${78 + i * 20})"><rect x="0" y="-9" width="12" height="12" rx="3" fill="${p.color}" /><text x="18" y="1" font-size="11.5" fill="${c.ink}" style="${font}">${esc(p.label)}: ${Math.round(100 * p.kwh / use)}%</text></g>`).join('');
  charts.push(`
      <figure class="roi-fig">
        <figcaption>Where your power comes from</figcaption>
        <svg viewBox="0 0 220 ${80 + parts.length * 20}" width="100%" role="img" aria-label="${esc(parts.map(p => `${p.label} ${Math.round(100 * p.kwh / use)}%`).join(', '))}">
          <text x="10" y="18" font-size="11" fill="${c.muted}" style="${font}">Of the ${Math.round(roi.annualKwh).toLocaleString('en-AU')} kWh you use a year</text>
          ${segs}
          ${legend}
        </svg>
      </figure>`);

  if (dollars && roi.netCost > 0 && roi.cumulative) {
    // 3. Savings adding up against the investment.
    const cum = roi.cumulative;
    const maxV = Math.max(cum[25], roi.netCost, 1);
    const X = (y) => 36 + Math.round(y * 170 / 25);
    const Y = (v) => 130 - Math.round(110 * v / maxV);
    const path = cum.map((v, y) => `${y === 0 ? 'M' : 'L'}${X(y)},${Y(v)}`).join(' ');
    const pb = roi.paybackYears && roi.paybackYears <= 25 ? roi.paybackYears : null;
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Savings add up</figcaption>
        <svg viewBox="0 0 220 170" width="100%" role="img" aria-label="Savings reach ${esc(money(cum[10]))} after 10 years and ${esc(money(cum[25]))} after 25 years against an investment of ${esc(money(roi.netCost))}">
          <line x1="36" y1="130" x2="206" y2="130" stroke="${c.line}" stroke-width="1" />
          <line x1="36" y1="${Y(roi.netCost)}" x2="206" y2="${Y(roi.netCost)}" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" />
          <text x="206" y="${Y(roi.netCost) + 13}" text-anchor="end" font-size="10.5" fill="${c.muted}" style="${font}">Your investment ${esc(money(roi.netCost))}</text>
          <path d="${path}" fill="none" stroke="${c.solar}" stroke-width="2" stroke-linejoin="round" />
          ${pb ? `<circle cx="${X(pb)}" cy="${Y(roi.netCost)}" r="5" fill="${c.solar}" stroke="#fff" stroke-width="2" /><text x="${X(pb) + 9}" y="${Y(roi.netCost) + 4}" text-anchor="start" font-size="10.5" font-weight="600" fill="${c.ink}" style="${font}">Paid off in year ${esc(Math.ceil(pb))}</text>` : ''}
          <circle cx="${X(25)}" cy="${Y(cum[25])}" r="4" fill="${c.solar}" stroke="#fff" stroke-width="2" />
          <text x="${X(25)}" y="${Y(cum[25]) - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${esc(money(cum[25]))}</text>
          <text x="36" y="148" font-size="10.5" fill="${c.muted}" style="${font}">Today</text>
          <text x="${X(10)}" y="148" text-anchor="middle" font-size="10.5" fill="${c.muted}" style="${font}">10 years</text>
          <text x="206" y="148" text-anchor="end" font-size="10.5" fill="${c.muted}" style="${font}">25 years</text>
        </svg>
      </figure>`);
  }
  return `<div class="roi-charts">${charts.join('')}</div>`;
}

function roiAssumptionsText(roi) {
  const a = ROI_ASSUMPTIONS;
  return `Estimates only, from your electricity bill and these assumptions: ${roi.yieldPerKw} kWh generated per kW of panels per day on average over the year, electricity bought at ${roi.usageRate} c/kWh${roi.feedInFromBill ? '' : ' and'} ${roi.feedInFromBill ? `and sold at ${roi.feedIn} c/kWh as shown on your bill` : `sold at ${roi.feedIn} c/kWh`}, prices rising ${Math.round(a.priceRisePerYear * 100)}% a year, panels losing ${a.panelDegradationPerYear * 100}% of output a year${roi.batteryKwh ? `, the battery cycling ${Math.round(a.batteryUsableCycle * 100)}% of its usable capacity daily at ${Math.round(a.batteryRoundTrip * 100)}% round trip efficiency` : ''}. Actual savings depend on weather, how and when you use power, and your retailer's rates.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROI_ASSUMPTIONS, billMetrics, suggestSizes, roiFor, roiRows, roiAssumptionsText, roiGaps, roiPresentation, roiChartsHtml, existingSolarKw };
}
