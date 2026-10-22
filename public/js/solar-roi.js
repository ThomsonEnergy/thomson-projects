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
    saving10: over(10), saving25: over(25), co2TonnesPerYear: Math.round(co2Tonnes * 10) / 10,
    annualReturnPercent: cost > 0 ? Math.round(annualSaving / cost * 1000) / 10 : null,
  };
}

function annualUseCost(m) {
  return (m.annualKwh || 0) * m.usageRate / 100;
}

// Rows for a savings table (proposal and the quote page preview). money() is the caller's formatter.
function roiRows(roi, money) {
  if (!roi) return [];
  const kwh = (n) => `${Math.round(n).toLocaleString('en-AU')} kWh`;
  const rows = [
    ['Your use now', `${kwh(roi.annualKwh)} a year (${roi.dailyKwh} kWh a day)`],
    ['Your bills now', `${money(roi.annualBillNow)} a year`],
  ];
  if (roi.newSolarKw) rows.push(['Solar generated', `${kwh(roi.generationKwh)} a year from ${roi.newSolarKw} kW of panels`]);
  if (roi.batteryKwh) rows.push(['Stored for the evening', `${kwh(roi.shiftedKwh)} a year through the ${roi.batteryKwh} kWh battery`]);
  rows.push(['Used at home', `${kwh(roi.selfUseKwh)} a year (${roi.selfUseShare}% of what the system makes)`]);
  rows.push(['Sent to the grid', `${kwh(roi.exportedKwh)} a year at ${roi.feedIn} c/kWh`]);
  rows.push(['Bought from the grid after', `${kwh(roi.gridKwhAfter)} a year (${roi.gridShareAfter}% less than now)`]);
  rows.push(['Estimated bills after', `${money(roi.annualBillAfter)} a year`]);
  rows.push(['Estimated saving', `${money(roi.annualSaving)} a year`]);
  if (roi.netCost) rows.push(['Your investment', `${money(roi.netCost)} after the credits`]);
  if (roi.paybackYears) rows.push(['Pays for itself in', `${roi.paybackYears} years`]);
  if (roi.annualReturnPercent) rows.push(['Yearly return', `${roi.annualReturnPercent}% of the investment`]);
  rows.push(['Saving over 10 years', money(roi.saving10)]);
  rows.push(['Saving over 25 years', money(roi.saving25)]);
  rows.push(['Emissions avoided', `about ${roi.co2TonnesPerYear} tonnes of CO2 a year`]);
  return rows;
}

function roiAssumptionsText(roi) {
  const a = ROI_ASSUMPTIONS;
  return `Estimates only, from your electricity bill and these assumptions: ${roi.yieldPerKw} kWh generated per kW of panels per day on average over the year, electricity bought at ${roi.usageRate} c/kWh${roi.feedInFromBill ? '' : ' and'} ${roi.feedInFromBill ? `and sold at ${roi.feedIn} c/kWh as shown on your bill` : `sold at ${roi.feedIn} c/kWh`}, prices rising ${Math.round(a.priceRisePerYear * 100)}% a year, panels losing ${a.panelDegradationPerYear * 100}% of output a year${roi.batteryKwh ? `, the battery cycling ${Math.round(a.batteryUsableCycle * 100)}% of its usable capacity daily at ${Math.round(a.batteryRoundTrip * 100)}% round trip efficiency` : ''}. Actual savings depend on weather, how and when you use power, and your retailer's rates.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROI_ASSUMPTIONS, billMetrics, suggestSizes, roiFor, roiRows, roiAssumptionsText, existingSolarKw };
}
