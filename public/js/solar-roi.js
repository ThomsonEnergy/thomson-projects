// Solar and battery sizing plus the savings estimate shown on a proposal. One file shared by the
// browser (quote page preview, the proposal) and the functions (read-electricity-bill.js), so the
// staff preview and what the client sees are the same maths. Plain script plus the module.exports
// guard at the bottom: no DOM access at load time.
//
// Inputs: the AI reading of the customer's electricity bill (projects.bill_reading), the rates
// (projects.roi_inputs: the bill's rates, editable, plus an optional second plan to compare and an
// optional battery export window), the quoted solar kW, battery kWh and prices. Every figure is an
// estimate from the assumptions below; the proposal says so. docs/IDEAS_BACKLOG.md item 29.
//
// How the estimate is worked out (roiEstimate):
//   1. A typical day in each of four seasons, hour by hour: the home's load follows a normal
//      household shape (morning bump, evening peak), stretched to match the bill's peak / shoulder /
//      off-peak split when it has one; the panels follow a daylight curve scaled by the zone's yield
//      and the season.
//   2. Solar first: each hour the panels cover the load, the rest is exported at the feed-in rate,
//      any shortfall is bought at that hour's rate (peak, shoulder, off-peak or flat).
//   3. Then the battery: it charges from what would have been exported, and discharges into the
//      shortfall at that hour's rate. With an export window set, it sells to the grid in that window
//      at the window's rate first when that rate beats the import rate.
//   4. Bills are added up at the plan's rates for three stages (as the home is now, with the solar,
//      with the solar and the battery) so each step's saving and payback is its own difference.
//   5. The second plan runs the same three stages at its rates.

const ROI_ASSUMPTIONS = {
  // kWh generated per kW of panels per day, by STC zone rating (Clean Energy Council guide figures).
  yieldPerKwPerDay: { 1.622: 4.4, 1.536: 4.2, 1.382: 3.9, 1.185: 3.5 },
  defaultZoneRating: 1.382,
  // Share of a home's use that falls in daylight hours when the bill gives no time-of-use split
  // (sizing only; the estimate uses the hourly shape below).
  daytimeShare: 0.40,
  batteryRoundTrip: 0.90,     // kWh out per kWh in (split evenly between charging and discharging)
  batteryUsableCycle: 0.85,   // share of usable capacity cycled on an average day (sizing)
  batteryMaxChargeC: 0.5,     // charges or discharges at most half its usable capacity in an hour
  priceRisePerYear: 0.03,     // electricity price growth used for the 10 and 25 year figures
  panelDegradationPerYear: 0.005,
  gridEmissionsKgPerKwh: 0.68, // NSW grid average
  defaultUsageRateCents: 33,
  defaultFeedInCents: 5,
  defaultSupplyChargeCents: 110,
  solarSizesKw: [6.6, 8, 10, 13.2, 15, 20, 26.6, 30],
  batterySizesKwh: [5, 10, 13.5, 16, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100],
  minBatteryKwh: 5,
  maxBatteryKwh: 100,
  // Four seasons, each a quarter of the year: how much the panels make and the home uses against
  // the yearly average. Within each season, 30% of days are overcast (the panels make about a third
  // of a clear day) and the rest are clear, so the season still averages out: the battery does not
  // fill every day, which is what keeps the home on the grid some of the time.
  dayTypes: [{ name: 'clear', share: 0.7, gen: 1.2786 }, { name: 'overcast', share: 0.3, gen: 0.35 }],
  seasons: [
    { name: 'Summer', gen: 1.25, load: 1.10 },
    { name: 'Autumn', gen: 1.00, load: 0.90 },
    { name: 'Winter', gen: 0.70, load: 1.15 },
    { name: 'Spring', gen: 1.05, load: 0.85 },
  ],
  // A normal household day by hour (0 to 23), before stretching to the bill's split.
  loadShape: [0.6, 0.55, 0.5, 0.5, 0.5, 0.6, 0.9, 1.2, 1.1, 0.9, 0.8, 0.8, 0.8, 0.8, 0.85, 0.95, 1.2, 1.6, 1.9, 1.8, 1.5, 1.2, 0.9, 0.7],
  // Default time-of-use windows (NSW networks: peak afternoon and evening, off-peak overnight).
  defaultPeakHours: '14:00-20:00',
  defaultShoulderHours: '07:00-14:00, 20:00-22:00',
};

function roiNum(v) {
  if (v == null || v === '') return null;
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
  // zero or below is a mistake, not a figure: treated as not on the bill (roiChecks says so)
  const pos = (v) => { const n = roiNum(v); return n != null && n > 0 ? n : null; };
  const days = pos(r.billing_days);
  const totalKwh = pos(r.total_kwh);
  let dailyKwh = pos(r.daily_average_kwh);
  if (!dailyKwh && totalKwh && days) dailyKwh = totalKwh / days;
  const billTotal = roiNum(r.bill_total);
  const annualBill = billTotal && days ? billTotal * 365 / days : null;
  const peak = roiNum(r.peak_kwh), shoulder = roiNum(r.shoulder_kwh), offPeak = roiNum(r.off_peak_kwh), solarSoak = roiNum(r.solar_soak_kwh), controlled = roiNum(r.controlled_load_kwh);
  const split = (peak || shoulder || offPeak || solarSoak) ? { peak: peak || 0, shoulder: shoulder || 0, offPeak: offPeak || 0, solarSoak: solarSoak || 0, controlled: controlled || 0 } : null;
  const usageRate = roiNum(r.usage_rate_c_per_kwh) || ROI_ASSUMPTIONS.defaultUsageRateCents;
  const feedIn = roiNum(r.feed_in_c_per_kwh);
  const supplyCharge = roiNum(r.supply_charge_c_per_day) || ROI_ASSUMPTIONS.defaultSupplyChargeCents;
  const exportKwh = roiNum(r.solar_export_kwh);
  const controlledDaily = controlled && days ? controlled / days : 0;
  return {
    days, totalKwh, dailyKwh: dailyKwh ? Math.round(dailyKwh * 10) / 10 : null,
    annualKwh: dailyKwh ? Math.round(dailyKwh * 365) : null,
    controlledDailyKwh: Math.round(controlledDaily * 10) / 10,
    billTotal, annualBill: annualBill ? Math.round(annualBill) : null,
    split, usageRate, feedIn: feedIn == null ? ROI_ASSUMPTIONS.defaultFeedInCents : feedIn, feedInFromBill: feedIn != null,
    supplyCharge, exportKwh,
    hasSolarAlready: !!(exportKwh && exportKwh > 0),
  };
}

// Share of use outside daylight: the off-peak plus peak share where the bill splits it (peak is the
// evening on NSW tariffs), else the default. Sizing only.
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
    if (wanted > ROI_ASSUMPTIONS.maxBatteryKwh) notes.push(`The evening use alone would take about ${Math.round(wanted)} kWh of battery; 100 kWh is the top of the discount band (the discount covers the first 50 kWh), so a bigger system is a commercial job sized by hand.`);
  }
  return {
    solarKw, solarRawKw: solarRaw ? Math.round(solarRaw * 10) / 10 : null, existingKw, yieldPerKw,
    batteryKwh, eveningKwhPerDay: eveningKwh ? Math.round(eveningKwh * 10) / 10 : null,
    dailyKwh: m.dailyKwh, notes,
  };
}

// The battery on the quote, from its line items: every line that names a battery with a kWh figure
// ("Sigen Battery 8kWh", "Powerwall 3 13.5 kWh"), times its quantity. Used when nothing is typed on
// step 3, so the estimate follows what is quoted. Works on the quote page's centres and on the
// proposal's (description plus quantity on both).
function roiBatteryKwhFromLines(centres) {
  let total = 0;
  (centres || []).forEach(c => {
    const stageIsBattery = /batter/i.test(c.name || '');
    (c.cost_centre_line_items || c.line_items || []).forEach(li => {
      const text = `${li.description || ''} ${li.prebuild_client_description || ''}`;
      if (!/batter|powerwall|sigenstor|storage/i.test(text) && !stageIsBattery) return;
      if (/gateway|inverter|cable|labour|bracket|mount/i.test(text) && !/batter/i.test(text)) return;
      const m = text.match(/(\d+(?:\.\d+)?)\s*kwh/i);
      if (!m) return;
      const qty = roiNum(li.quantity) || 1;
      total += parseFloat(m[1]) * qty;
    });
  });
  return Math.round(total * 10) / 10;
}

// The default split of the quote's price between the solar and the battery, so each gets its own
// payback without anyone typing two prices: the battery is its own stage (a stage named battery, or
// one whose lines carry battery kWh), inc GST, less the BSTC credit; the solar is everything else
// (panels, inverter, roof edge protection...) after the credits. The two always add to the total.
// bstcCredit is the credit as the caller shows it (inc GST for a company client on the proposal).
function roiDefaultPrices({ centres, netCost, bstcCredit }) {
  const total = roiNum(netCost) || 0;
  let batteryExGst = 0;
  (centres || []).forEach(c => { if (/batter/i.test(c.name || '') || roiBatteryKwhFromLines([c]) > 0) batteryExGst += Number(c.quoted_amount) || 0; });
  if (!(batteryExGst > 0) || !(total > 0)) return { solar: null, battery: null };
  const battery = Math.max(0, Math.round(batteryExGst * 1.1 - (roiNum(bstcCredit) || 0)));
  return { battery: Math.min(battery, total), solar: Math.max(0, Math.round(total - battery)) };
}

// The two prices the estimate runs on: both typed, used as typed; one typed, the other is the rest
// of the total (roiEstimate does that); none typed, the default split above.
function roiPricesFor({ typedSolar, typedBattery, defaults }) {
  const ts = roiNum(typedSolar), tb = roiNum(typedBattery);
  if (ts != null || tb != null) return { solar: ts, battery: tb, fromDefault: false };
  const d = defaults || {};
  return { solar: d.solar ?? null, battery: d.battery ?? null, fromDefault: d.solar != null || d.battery != null };
}

// ---------- rates (a plan) ----------

// The time-of-use bands a plan can have. Solar soak (some plans call it super off-peak) is a cheap
// window in the middle of the day with its own rate; most plans do not have one. Off-peak is not
// only overnight: many plans make the middle of the day or the weekend off-peak too.
const ROI_BANDS = [
  { key: 'peak', label: 'Peak', color: '#dc2626' },
  { key: 'shoulder', label: 'Shoulder', color: '#f59e0b' },
  { key: 'off_peak', label: 'Off-peak', color: '#16a34a' },
  { key: 'solar_soak', label: 'Solar soak', color: '#0ea5e9' },
];
const ROI_BAND_LABEL = { flat: 'Usage', peak: 'Peak', shoulder: 'Shoulder', off_peak: 'Off-peak', solar_soak: 'Solar soak' };
const ROI_SEASON_MONTHS = [[12, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]]; // same order as ROI_ASSUMPTIONS.seasons
const ROI_DAY_KINDS = [{ key: 'weekday', label: 'Weekdays', share: 5 / 7 }, { key: 'weekend', label: 'Weekends', share: 2 / 7 }];
const ROI_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "14:00-20:00, 07:00-09:00" (or "3pm to 9pm") to a set of hours. A window that crosses midnight wraps.
function roiParseHours(text) {
  const hours = new Set();
  const toHour = (num, mer) => { let h = parseInt(num, 10); if (mer === 'pm' && h < 12) h += 12; if (mer === 'am' && h === 12) h = 0; return h; };
  String(text || '').toLowerCase().split(/[,;&]|\band\b/).forEach(part => {
    const m = part.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return;
    const from = toHour(m[1], m[3] || (m[6] && parseInt(m[1], 10) <= parseInt(m[4], 10) ? m[6] : m[3])) % 24;
    let to = toHour(m[4], m[6]);
    if (to === 24) to = 0;
    to = to % 24;
    if (from === to) { for (let h = 0; h < 24; h++) hours.add(h); return; }
    for (let h = from; h !== to; h = (h + 1) % 24) hours.add(h);
  });
  return hours;
}

// "Nov-Mar, Jun-Aug" (or "November to March", "Jun, Jul, Aug") to a set of month numbers; blank is all year.
function roiParseMonths(text) {
  const all = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const t = String(text || '').trim().toLowerCase();
  if (!t || /all year|every month|all months|year round/.test(t)) return all;
  const idx = (w) => { const i = ROI_MONTH_NAMES.indexOf(String(w).trim().slice(0, 3)); return i < 0 ? null : i + 1; };
  const out = new Set();
  t.split(/[,;&]|\band\b/).forEach(part => {
    const m = part.trim().match(/^([a-z]+)\s*(?:-|to|–)\s*([a-z]+)$/);
    if (m) {
      const a = idx(m[1]), b = idx(m[2]);
      if (a && b) for (let k = a, n = 0; n < 12; k = k % 12 + 1, n++) { out.add(k); if (k === b) break; }
      return;
    }
    const one = idx(part.trim());
    if (one) out.add(one);
  });
  return out.size ? out : all;
}

function roiDays(v) {
  const t = String(v || '').toLowerCase();
  if (/weekend|sat|sun/.test(t) && !/week ?day|working|mon|business/.test(t)) return 'weekends';
  if (/week ?day|working|mon|business/.test(t)) return 'weekdays';
  return 'all';
}

function roiBandKey(v) {
  const t = String(v || '').toLowerCase();
  if (/soak|super/.test(t)) return 'solar_soak';
  if (/shoulder/.test(t)) return 'shoulder';
  if (/off/.test(t)) return 'off_peak';
  if (/peak/.test(t)) return 'peak';
  return null;
}

function roiCleanWindows(list) {
  return (Array.isArray(list) ? list : [])
    .map(w => ({ band: roiBandKey(w && w.band), hours: String((w && w.hours) || '').trim(), days: roiDays(w && w.days), months: String((w && w.months) || '').trim() }))
    .filter(w => w.band && w.hours && roiParseHours(w.hours).size);
}

// The times the bill prints for each band: tou_schedule from the reader (one entry per band and
// pattern), or the older tou_hours object.
function roiBillWindows(reading) {
  const r = reading || {};
  if (Array.isArray(r.tou_schedule) && r.tou_schedule.length) return roiCleanWindows(r.tou_schedule);
  const h = r.tou_hours || {};
  return roiCleanWindows(ROI_BANDS.filter(b => h[b.key]).map(b => ({ band: b.key, hours: h[b.key], days: 'all' })));
}

// The rates a plan charges and when, with the bill's figures as the fallback for anything not typed.
// Rate fields: tariff ('flat' | 'tou'), rate, peak, shoulder, off_peak, solar_soak, controlled,
// supply, feed_in, name. Times: windows [{ band, hours, days, months }] and other (the band at any
// time not listed). Older saved plans with peak_hours / shoulder_hours still work.
function roiPlan(saved, reading, fallbackName) {
  const r = reading || {};
  const s = saved || {};
  const rates = r.usage_rates || {};
  const billTou = !!(roiNum(rates.peak) && (roiNum(rates.off_peak) != null)) || r.tariff_type === 'time_of_use';
  const tariff = s.tariff || (billTou && roiNum(rates.peak) ? 'tou' : 'flat');
  const fromBill = { rate: r.usage_rate_c_per_kwh, peak: rates.peak, shoulder: rates.shoulder, off_peak: rates.off_peak, solar_soak: rates.solar_soak ?? rates.super_off_peak, controlled: rates.controlled_load, supply: r.supply_charge_c_per_day, feed_in: r.feed_in_c_per_kwh };
  const plan = { name: s.name || fallbackName, tariff, rateKnown: {} };
  Object.keys(fromBill).forEach(k => {
    plan[k] = roiNum(s[k]) != null ? roiNum(s[k]) : roiNum(fromBill[k]);
    plan.rateKnown[k] = plan[k] != null;
  });

  // when each band applies: typed, else the bill, else assumed
  let windows;
  if (Array.isArray(s.windows)) { windows = roiCleanWindows(s.windows); plan.timesFrom = 'typed'; }
  else if ((s.peak_hours && String(s.peak_hours).trim()) || (s.shoulder_hours && String(s.shoulder_hours).trim())) {
    windows = roiCleanWindows([{ band: 'peak', hours: s.peak_hours }, { band: 'shoulder', hours: s.shoulder_hours }]);
    plan.timesFrom = 'typed';
  } else {
    windows = roiBillWindows(r);
    plan.timesFrom = windows.length ? 'bill' : 'assumed';
  }
  // the bands this plan has: a rate, a window, or kWh on the bill for it
  const has = {
    peak: true,
    off_peak: true,
    shoulder: plan.rateKnown.shoulder || windows.some(w => w.band === 'shoulder') || roiNum(r.shoulder_kwh) > 0,
    solar_soak: plan.rateKnown.solar_soak || windows.some(w => w.band === 'solar_soak') || roiNum(r.solar_soak_kwh) > 0,
  };
  if (tariff === 'tou' && plan.timesFrom === 'assumed') {
    windows = [{ band: 'peak', hours: ROI_ASSUMPTIONS.defaultPeakHours, days: 'all', months: '' }];
    if (has.shoulder) windows.push({ band: 'shoulder', hours: ROI_ASSUMPTIONS.defaultShoulderHours, days: 'all', months: '' });
  }
  const bandsWithout = Object.keys(has).filter(b => has[b] && !windows.some(w => w.band === b));
  const otherFrom = s.other || (plan.timesFrom === 'bill' ? roiBandKey(r.tou_other) : null);
  plan.other = otherFrom || (bandsWithout.includes('off_peak') ? 'off_peak' : bandsWithout[0] || 'off_peak');
  plan.windows = windows;
  plan.bands = ROI_BANDS.map(b => b.key).filter(b => has[b] || plan.other === b);

  if (tariff === 'tou') {
    if (plan.peak == null) plan.peak = plan.rate;
    if (plan.off_peak == null) plan.off_peak = plan.rate != null ? Math.round(plan.rate * 0.7 * 10) / 10 : null;
    if (plan.shoulder == null && plan.peak != null && plan.off_peak != null) plan.shoulder = Math.round((plan.peak + plan.off_peak) / 2 * 10) / 10;
    if (plan.solar_soak == null) plan.solar_soak = plan.off_peak;
  } else if (plan.rate == null && plan.peak != null) {
    plan.rate = plan.peak;
  }
  if (plan.controlled == null) plan.controlled = tariff === 'tou' ? plan.off_peak : plan.rate;
  plan.hasShoulder = has.shoulder;
  plan.hasRate = tariff === 'tou' ? (plan.peak != null && plan.off_peak != null) : plan.rate != null;
  plan.feedInKnown = plan.feed_in != null;
  if (plan.feed_in == null) plan.feed_in = ROI_ASSUMPTIONS.defaultFeedInCents;
  plan.supplyKnown = plan.supply != null;
  if (plan.supply == null) plan.supply = ROI_ASSUMPTIONS.defaultSupplyChargeCents;

  // the band for every hour of a weekday and a weekend day in each season; where two windows
  // cover the same hour the narrower one wins (a solar soak window inside a long shoulder, say)
  const parsed = windows.map(w => {
    const hourSet = roiParseHours(w.hours), monthSet = roiParseMonths(w.months);
    return { ...w, hourSet, monthSet, size: hourSet.size * (w.days === 'all' ? 7 : w.days === 'weekdays' ? 5 : 2) * monthSet.size };
  }).sort((a, b) => a.size - b.size);
  const inSeason = (monthSet, si) => ROI_SEASON_MONTHS[si].filter(m => monthSet.has(m)).length >= 2;
  const dayOk = (w, dk) => w.days === 'all' || (w.days === 'weekdays') === (dk === 0);
  plan.overlaps = [];
  plan.grid = ROI_ASSUMPTIONS.seasons.map((_, si) => ROI_DAY_KINDS.map((__, dk) => {
    const row = [];
    for (let h = 0; h < 24; h++) {
      if (tariff !== 'tou') { row.push('flat'); continue; }
      const hits = parsed.filter(w => w.hourSet.has(h) && dayOk(w, dk) && inSeason(w.monthSet, si));
      if (hits.length > 1 && new Set(hits.map(w => w.band)).size > 1) plan.overlaps.push({ si, dk, h, bands: hits.map(w => w.band) });
      row.push(hits.length ? hits[0].band : plan.other);
    }
    return row;
  }));
  plan.bandOf = (h, si = 0, dk = 0) => plan.grid[si][dk][h];
  plan.rateOf = (h, si = 0, dk = 0) => { const b = plan.grid[si][dk][h]; return b === 'flat' ? plan.rate : plan[b]; };
  plan.bandLabel = ROI_BAND_LABEL;
  // bands that apply at some time, and how much of the year each covers
  plan.bandShare = {};
  plan.grid.forEach(seasonRows => seasonRows.forEach((row, dk) => row.forEach(b => { plan.bandShare[b] = (plan.bandShare[b] || 0) + ROI_DAY_KINDS[dk].share / 4 / 24; })));
  return plan;
}

// "15:00-21:00" style ranges for the hours of a day in a band, joined with "and".
function roiHoursText(hours) {
  const set = new Set(hours);
  if (set.size === 24) return 'all day';
  if (!set.size) return '';
  const runs = [];
  let start = [...Array(24).keys()].find(h => set.has(h) && !set.has((h + 23) % 24));
  if (start == null) return 'all day';
  const seen = new Set();
  for (let k = 0; k < 24; k++) {
    const h = (start + k) % 24;
    if (!set.has(h) || seen.has(h)) continue;
    let end = h;
    while (set.has((end + 1) % 24) && !seen.has((end + 1) % 24) && (end + 1) % 24 !== h) { seen.add(end); end = (end + 1) % 24; }
    seen.add(end);
    runs.push(`${String(h).padStart(2, '0')}:00-${String((end + 1) % 24).padStart(2, '0')}:00`);
  }
  return runs.join(' and ');
}

// The day patterns a plan has (identical days grouped), each with a plain label.
function roiDayPatterns(plan) {
  const groups = [];
  plan.grid.forEach((seasonRows, si) => seasonRows.forEach((row, dk) => {
    const key = row.join(',');
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, row, members: [] }; groups.push(g); }
    g.members.push({ si, dk });
  }));
  const seasonNames = ROI_ASSUMPTIONS.seasons.map(s => s.name.toLowerCase());
  const list = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
  groups.forEach(g => {
    const parts = ROI_DAY_KINDS.map((d, dk) => {
      const seasons = g.members.filter(m => m.dk === dk).map(m => m.si);
      if (!seasons.length) return null;
      return seasons.length === 4 ? d.label.toLowerCase() : `${d.label.toLowerCase()} in ${list(seasons.map(si => seasonNames[si]))}`;
    }).filter(Boolean);
    const label = g.members.length === 8 ? 'every day' : list(parts);
    g.label = label.charAt(0).toUpperCase() + label.slice(1);
  });
  return groups;
}

// "Weekdays: peak 15:00-21:00, off-peak 21:00-15:00. Weekends: off-peak all day."
function roiScheduleText(plan) {
  if (plan.tariff !== 'tou') return 'one rate at all times';
  return roiDayPatterns(plan).map(g => {
    const bands = ROI_BANDS.map(b => b.key).filter(b => g.row.includes(b));
    return `${g.label}: ${bands.map(b => `${ROI_BAND_LABEL[b].toLowerCase()} ${roiHoursText(g.row.map((x, h) => (x === b ? h : -1)).filter(h => h >= 0))}`).join(', ')}`;
  }).join('. ');
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

// The hourly load shape, stretched so the hours in each band add up to the bill's split. Hours can
// be in different bands on weekdays and weekends or by season, so the stretch is fitted over the
// whole year (a few rounds of proportional fitting).
function roiLoadShape(metrics, plan) {
  const base = ROI_ASSUMPTIONS.loadShape.slice();
  const total = base.reduce((s, v) => s + v, 0);
  let shape = base.map(v => v / total);
  if (!metrics.split || plan.tariff !== 'tou') return shape;
  const sp = metrics.split;
  const want = { peak: sp.peak, shoulder: sp.shoulder, off_peak: sp.offPeak, solar_soak: sp.solarSoak || 0 };
  const splitTotal = Object.values(want).reduce((a, b) => a + b, 0);
  if (!(splitTotal > 0)) return shape;
  Object.keys(want).forEach(b => { want[b] /= splitTotal; });
  // share of the year each hour spends in each band
  const mem = [];
  for (let h = 0; h < 24; h++) {
    const m = { peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 };
    plan.grid.forEach(seasonRows => seasonRows.forEach((row, dk) => { m[row[h]] += ROI_DAY_KINDS[dk].share / 4; }));
    mem.push(m);
  }
  const bandsUsed = Object.keys(want).filter(b => mem.some(m => m[b] > 0));
  // only stretch when every band the plan has hours for also has kWh on the bill; otherwise the
  // bill's bands and the plan's times do not line up and the normal day shape is the safer guess
  if (!bandsUsed.every(b => want[b] > 0)) return shape;
  for (let round = 0; round < 40; round++) {
    const have = { peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 };
    shape.forEach((v, h) => bandsUsed.forEach(b => { have[b] += v * mem[h][b]; }));
    const f = {};
    bandsUsed.forEach(b => { f[b] = have[b] > 0 ? want[b] / have[b] : 1; });
    shape = shape.map((v, h) => v * bandsUsed.reduce((s, b) => s + mem[h][b] * f[b], 0));
    const sum = shape.reduce((s, v) => s + v, 0);
    shape = shape.map(v => v / sum);
  }
  return shape;
}

function roiSolarShape() {
  const w = [];
  for (let h = 0; h < 24; h++) w.push(h >= 6 && h < 18 ? Math.max(0, Math.sin(Math.PI * (h + 0.5 - 6) / 12)) : 0);
  const total = w.reduce((s, v) => s + v, 0);
  return w.map(v => v / total);
}

// One stage (a solar size and a battery size) for one plan over a year: the kWh and the bill.
// Every combination of season, clear or overcast day, and weekday or weekend is run hour by hour,
// each priced at its own band. The battery keeps its charge for dearer hours still to come before
// the panels can refill it (it does not spend it in a cheap midday or overnight off-peak hour when
// peak is still ahead), and carries what is left into the next morning.
function roiRunStage({ metrics, plan, loadShape, solarShape, solarKw, batteryKwh, yieldPerKw, exportWindow }) {
  const dailyGeneral = Math.max(0, (metrics.dailyKwh || 0) - (metrics.controlledDailyKwh || 0));
  const eff = Math.sqrt(ROI_ASSUMPTIONS.batteryRoundTrip);
  const cRate = batteryKwh * ROI_ASSUMPTIONS.batteryMaxChargeC;
  const exp = exportWindow && exportWindow.enabled && roiNum(exportWindow.rate) > 0 ? {
    hours: roiParseHours(`${exportWindow.from || '17:00'}-${exportWindow.to || '21:00'}`),
    rate: roiNum(exportWindow.rate),
    maxKwh: roiNum(exportWindow.max_kwh) || batteryKwh,
  } : null;
  const totals = { generation: 0, selfUse: 0, charged: 0, discharged: 0, batteryExport: 0, exported: 0, imported: 0, importBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, costBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, dischargedBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, load: 0 };
  ROI_ASSUMPTIONS.seasons.forEach((season, si) => ROI_ASSUMPTIONS.dayTypes.forEach(dayType => ROI_DAY_KINDS.forEach((dayKind, dk) => {
    const days = 365 / ROI_ASSUMPTIONS.seasons.length * dayType.share * dayKind.share;
    // the day from 6am, before the battery
    const day = [];
    for (let i = 0; i < 24; i++) {
      const h = (6 + i) % 24;
      const load = dailyGeneral * loadShape[h] * season.load;
      const gen = solarKw * yieldPerKw * season.gen * dayType.gen * solarShape[h];
      day.push({ h, load, gen, band: plan.bandOf(h, si, dk), rate: plan.rateOf(h, si, dk) || 0 });
    }
    // what the home will still buy at a rate above `above` before the panels next have spare power
    const dearerAhead = (i, above) => {
      let sum = 0;
      for (let k = 1; k < 24; k++) {
        const d = day[(i + k) % 24];
        if (d.gen > d.load + 1e-9) break;
        if (d.rate > above + 1e-6) sum += d.load - d.gen;
      }
      return sum;
    };
    let soc = 0;
    // run the day twice so the battery starts the counted day with what the last one left
    for (let pass = 0; pass < 2; pass++) {
      const count = pass === 1 ? days : 0;
      let exportLeft = exp ? exp.maxKwh : 0;
      for (let i = 0; i < 24; i++) {
        const d = day[i];
        if (d.h === 0) exportLeft = exp ? exp.maxKwh : 0;
        const self = Math.min(d.gen, d.load);
        let surplus = d.gen - self;
        let deficit = d.load - self;
        totals.generation += d.gen * count;
        totals.selfUse += self * count;
        totals.load += d.load * count;
        if (batteryKwh > 0) {
          const charge = Math.min(surplus, Math.max(0, batteryKwh - soc) / eff, cRate);
          soc += charge * eff;
          surplus -= charge;
          totals.charged += charge * count;
          let out = 0;
          if (exp && exp.hours.has(d.h) && exportLeft > 0 && exp.rate > d.rate) {
            const e = Math.max(0, Math.min(soc * eff - dearerAhead(i, exp.rate), exportLeft, cRate));
            soc -= e / eff;
            exportLeft -= e;
            out += e;
            totals.batteryExport += e * count;
          }
          const discharge = Math.max(0, Math.min(deficit, soc * eff - dearerAhead(i, d.rate), cRate - out));
          soc -= discharge / eff;
          deficit -= discharge;
          totals.discharged += discharge * count;
          totals.dischargedBy[d.band] += discharge * count;
        }
        totals.exported += surplus * count;
        totals.imported += deficit * count;
        totals.importBy[d.band] += deficit * count;
        totals.costBy[d.band] += deficit * count * d.rate / 100;
      }
    }
  })));
  const controlledKwh = (metrics.controlledDailyKwh || 0) * 365;
  const usageCost = Object.values(totals.costBy).reduce((s, v) => s + v, 0);
  const controlledCost = controlledKwh * (plan.controlled || 0) / 100;
  const supplyCost = plan.supply * 365 / 100;
  const feedInCredit = totals.exported * plan.feed_in / 100;
  const batteryExportCredit = exp ? totals.batteryExport * exp.rate / 100 : 0;
  const bill = usageCost + controlledCost + supplyCost - feedInCredit - batteryExportCredit;
  const round = (v) => Math.round(v);
  return {
    solarKw, batteryKwh,
    generation: round(totals.generation), selfUse: round(totals.selfUse), charged: round(totals.charged), discharged: round(totals.discharged),
    batteryExport: round(totals.batteryExport), exported: round(totals.exported), imported: round(totals.imported), controlledKwh: round(controlledKwh),
    importBy: Object.fromEntries(Object.entries(totals.importBy).map(([k, v]) => [k, round(v)])),
    costBy: Object.fromEntries(Object.entries(totals.costBy).map(([k, v]) => [k, round(v)])),
    dischargedBy: Object.fromEntries(Object.entries(totals.dischargedBy).map(([k, v]) => [k, round(v)])),
    usageCost: round(usageCost), controlledCost: round(controlledCost), supplyCost: round(supplyCost), feedInCredit: round(feedInCredit), batteryExportCredit: round(batteryExportCredit),
    bill: round(bill), exportRate: exp ? exp.rate : null,
  };
}

// The whole estimate: three stages on the current plan, and on the second plan when set.
function roiEstimate({ reading, answers, inputs, newSolarKw, batteryKwh, zoneRating, netCost, solarPrice, batteryPrice }) {
  const metrics = billMetrics(reading);
  if (!metrics.dailyKwh) return null;
  const inp = inputs || {};
  const yieldPerKw = ROI_ASSUMPTIONS.yieldPerKwPerDay[zoneRating] || ROI_ASSUMPTIONS.yieldPerKwPerDay[ROI_ASSUMPTIONS.defaultZoneRating];
  const existingKw = existingSolarKw(answers);
  const solar = roiNum(newSolarKw) || 0;
  const battery = roiNum(batteryKwh) || 0;
  const plans = [roiPlan(inp.current, reading, (reading && reading.retailer) ? `${reading.retailer} (current plan)` : 'Current plan')];
  if (inp.alt && inp.alt.enabled) plans.push(roiPlan(inp.alt, reading, inp.alt.name || 'Other plan'));
  const solarShape = roiSolarShape();
  const prices = {
    total: roiNum(netCost) || 0,
    solar: roiNum(solarPrice),
    battery: roiNum(batteryPrice),
  };
  if (prices.solar == null && prices.battery == null) {
    if (solar > 0 && battery <= 0) prices.solar = prices.total;
    if (battery > 0 && solar <= 0) prices.battery = prices.total;
  } else if (prices.solar == null && prices.battery != null && solar > 0) prices.solar = Math.max(0, prices.total - prices.battery);
  else if (prices.battery == null && prices.solar != null && battery > 0) prices.battery = Math.max(0, prices.total - prices.solar);
  const scenarios = plans.map((plan, idx) => {
    const loadShape = roiLoadShape(metrics, plan);
    const run = (kw, kwh) => roiRunStage({ metrics, plan, loadShape, solarShape, solarKw: kw, batteryKwh: kwh, yieldPerKw, exportWindow: kwh > 0 ? inp.export : null });
    const base = run(existingKw, 0);
    const withSolar = solar > 0 ? run(existingKw + solar, 0) : base;
    const full = battery > 0 ? run(existingKw + solar, battery) : withSolar;
    const solarSaving = Math.max(0, base.bill - withSolar.bill);
    const batterySaving = Math.max(0, withSolar.bill - full.bill);
    const totalSaving = Math.max(0, base.bill - full.bill);
    const payback = (price, saving) => (price > 0 && saving > 0 ? Math.round(price / saving * 10) / 10 : null);
    const grow = (saving, years) => { let sum = 0; for (let y = 0; y < years; y++) sum += saving * Math.pow(1 + ROI_ASSUMPTIONS.priceRisePerYear, y) * Math.pow(1 - ROI_ASSUMPTIONS.panelDegradationPerYear, y); return Math.round(sum); };
    const cumulative = []; for (let y = 0; y <= 25; y++) cumulative.push(grow(totalSaving, y));
    // "now" is the real bill when this is the current plan and the bill has a total; the model's
    // figure otherwise. The after figures move with the saving so the two always agree.
    const actualNow = idx === 0 && metrics.annualBill ? metrics.annualBill : null;
    const billNow = actualNow != null ? actualNow : base.bill;
    return {
      key: idx === 0 ? 'current' : 'alt', name: plan.name, plan,
      stages: { base, solar: withSolar, full },
      billNow, billNowIsActual: actualNow != null, modelledNow: base.bill,
      billWithSolar: Math.round(billNow - solarSaving), billAfter: Math.round(billNow - totalSaving),
      solarSaving: Math.round(solarSaving), batterySaving: Math.round(batterySaving), totalSaving: Math.round(totalSaving),
      solarPayback: payback(prices.solar, solarSaving), batteryPayback: payback(prices.battery, batterySaving), payback: payback(prices.total, totalSaving),
      returnPercent: prices.total > 0 ? Math.round(totalSaving / prices.total * 1000) / 10 : null,
      saving10: grow(totalSaving, 10), saving25: grow(totalSaving, 25), cumulative,
      co2TonnesPerYear: Math.round((full.generation - base.generation) * ROI_ASSUMPTIONS.gridEmissionsKgPerKwh / 1000 * 10) / 10,
    };
  });
  return { metrics, existingKw, newSolarKw: solar, batteryKwh: battery, yieldPerKw, prices, scenarios, current: scenarios[0], alt: scenarios[1] || null, exportWindow: inp.export && inp.export.enabled ? inp.export : null };
}

// ---------- what is missing ----------

// What is missing for an honest savings estimate. A `blocking` gap keeps the figures that rest on
// it off the proposal: the page asks the customer for what it needs (the `client` text) instead of
// showing a number built on a default. Gaps with no client text are the staff's to fix. The rest
// are warnings only: the figures show, with the assumption declared.
function roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice }) {
  const gaps = [];
  const a = answers || {};
  const r = reading || null;
  const m = billMetrics(r);
  const hasBattery = template === 'battery' || (template === 'solar' && a.with_battery === 'Yes');
  const plan = roiPlan((inputs || {}).current, r, 'Current plan');
  if (!r) {
    gaps.push({ key: 'bill', blocking: true, staff: 'No electricity bill read yet: add every page above and press Read bill with AI.', client: 'a recent electricity bill, every page, so we can see how much power you use and what you pay for it' });
  } else {
    if (!m.dailyKwh) gaps.push({ key: 'usage', blocking: true, staff: 'The bill gives no usage in kWh (no total kWh with the number of days, and no daily average).', client: 'the page of your bill with the usage table (kWh used and the number of days in the period)' });
    if (!plan.hasRate) gaps.push({ key: 'rate', blocking: true, staff: 'No usage rate (c/kWh) on the bill and none typed in the rates below.', client: 'the page of your bill that shows your rates (cents per kWh, and the daily supply charge)' });
    if (roiNum(r.bill_total) == null) gaps.push({ key: 'total', blocking: true, staff: 'No bill total found: "your bills now and after" are left off; the savings still show from the usage and the rates.', client: 'the page of your bill with the total amount for the period' });
    if (m.days && m.days < 28) gaps.push({ key: 'short', blocking: false, staff: `A ${m.days} day bill: the yearly figures are scaled up from it. A full quarterly bill is better.`, client: 'a full quarterly bill if you have one (the one we have covers only a short period)' });
    if ((m.hasSolarAlready || template === 'battery') && !existingSolarKw(a)) gaps.push({ key: 'existing', blocking: true, staff: `${template === 'battery' ? 'A battery quote' : 'The bill shows solar export'} but no existing solar size in the answers (Existing system details or Existing PV size, in kW).`, client: 'the size of your existing solar system in kW (on the inverter label or your original paperwork)' });
    if (!plan.supplyKnown) gaps.push({ key: 'supply', blocking: false, staff: `No daily supply charge on the bill or typed below; ${ROI_ASSUMPTIONS.defaultSupplyChargeCents} c/day assumed.`, client: null });
    if (!plan.feedInKnown && (roiNum(newSolarKw) > 0 || m.hasSolarAlready)) gaps.push({ key: 'feedin', blocking: false, staff: `No feed-in rate on the bill or typed below; ${ROI_ASSUMPTIONS.defaultFeedInCents} c/kWh assumed for what is exported.`, client: null });
    if (!m.split) gaps.push({ key: 'tou', blocking: false, staff: 'No peak / shoulder / off-peak split on the bill: a normal household day shape is used for when the power is used.', client: null });
  }
  if (template !== 'battery' && !(roiNum(newSolarKw) > 0)) gaps.push({ key: 'size', blocking: true, staff: 'No system size: set it on step 3 (STC system size) or pull the Pylon design.', client: null });
  if (hasBattery && !(roiNum(batteryKwh) > 0)) gaps.push({ key: 'battery', blocking: false, staff: 'No battery quoted and no battery kWh in the line items, so the estimate runs without one. Type the battery (usable kWh) under What we are quoting, or answer "Batteries as well?" No if this quote has no battery.', client: null });
  if (!(roiNum(netCost) > 0)) gaps.push({ key: 'price', blocking: true, staff: 'No price yet: the payback needs a priced stage on step 3.', client: null });
  else if (roiNum(newSolarKw) > 0 && roiNum(batteryKwh) > 0 && roiNum(solarPrice) == null && roiNum(batteryPrice) == null) gaps.push({ key: 'split_prices', blocking: false, staff: 'Solar and battery prices are not split on step 3, so only the combined payback shows (not one for each).', client: null });
  return gaps;
}

// What a missing piece would give the customer once we have it (the "to give you Y we need X" line).
const ROI_GAP_GIVES = {
  bill: 'your yearly saving, how soon the system pays for itself and the 10 and 25 year savings',
  usage: 'any savings figures',
  rate: 'the dollar savings, how soon the system pays for itself and the 10 and 25 year savings',
  total: 'your bills before and after',
  existing: 'the generation and savings figures for your home',
  short: 'a more accurate yearly figure',
};

// ---------- mistake checks (staff only) ----------

// Figures that are allowed but usually mean something was typed or read wrong. Each says what to
// look at. Never shown to the customer and never blocks sending: they sit in the bill card's box
// and on step 5 so they are seen before the proposal goes out.
function roiChecks({ reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, linesBatteryKwh, money, est }) {
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
  if (sp != null && bp != null && total > 0 && Math.abs(sp + bp - total) > Math.max(50, total * 0.01)) add('prices', `Solar ${fmt(sp)} plus battery ${fmt(bp)} is ${fmt(sp + bp)}, but the quote's total after credits is ${fmt(total)}: check the two prices.`);
  else if (total > 0 && ((sp != null && sp > total + 1) || (bp != null && bp > total + 1))) add('prices', `A price under What we are quoting is more than the whole quote (${fmt(total)} after credits): check it.`);
  if (est && est.current) {
    const c = est.current;
    const genExtra = c.stages.solar.generation - c.stages.base.generation;
    if (solar > 0 && est.metrics.annualKwh && genExtra > est.metrics.annualKwh * 2.5) add('oversized', `The solar makes about ${Math.round(genExtra / est.metrics.annualKwh * 10) / 10} times what the home uses in a year: check the size, or expect most of it to be exported.`);
    if (c.payback != null && (c.payback < 1 || c.payback > 25)) add('payback', `Pays for itself in ${c.payback} years, which is unusual: check the price, the sizes and the rates.`);
    if (c.billNowIsActual && c.modelledNow > 0) {
      const diff = (c.modelledNow - c.billNow) / c.billNow;
      if (Math.abs(diff) > 0.2) add('model_vs_bill', `These rates on this use come to ${fmt(c.modelledNow)} a year but the bill says ${fmt(c.billNow)} (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%): check the rates, the supply charge and the kWh split, or a discount on the bill.`);
    }
  }
  return out;
}

// ---------- presentation ----------

const roiKwh = (n) => `${Math.round(n).toLocaleString('en-AU')} kWh`;

// Everything the proposal (and the quote page preview) shows: the sections and rows we can stand
// behind with what we have (one value per plan), the asks ("to give you Y, we need X") for what the
// customer can supply, the staff-side gaps and the working. Nothing is withheld that we do have;
// nothing is shown that rests on a guess: no rates means kWh rows only, no bill total means no
// "bills now and after", no existing solar size when the bill shows export means use only.
function roiPresentation({ reading, answers, template, newSolarKw, batteryKwh, netCost, zoneRating, money, inputs, solarPrice, batteryPrice, linesBatteryKwh }) {
  const gaps = roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice });
  const has = (k) => !gaps.some(g => g.key === k);
  const asks = gaps.filter(g => g.client).map(g => ({ key: g.key, need: g.client, gives: ROI_GAP_GIVES[g.key] || 'a more accurate estimate', blocking: g.blocking }));
  const m = billMetrics(reading);
  const checkArgs = { reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, linesBatteryKwh, money };
  const empty = { gaps, asks, sections: [], columns: [], est: null, metrics: m, dollars: false, rows: [], checks: roiChecks({ ...checkArgs, est: null }) };
  if (!reading || !m.dailyKwh) return empty;
  const canModel = has('existing') && ((roiNum(newSolarKw) || 0) > 0 || (roiNum(batteryKwh) || 0) > 0);
  if (!canModel) {
    const sections = [{ title: 'Your home now', rows: [['Power used', [`${roiKwh(m.annualKwh)} a year (${m.dailyKwh} kWh a day)`]]] }];
    if (has('total') && m.annualBill) sections[0].rows.push(['Bills now', [`${money(m.annualBill)} a year`]]);
    return { ...empty, sections, columns: ['Estimate'], rows: sections[0].rows.map(([k, v]) => [k, v[0]]) };
  }
  const est = roiEstimate({ reading, answers, inputs, newSolarKw, batteryKwh, zoneRating, netCost, solarPrice, batteryPrice });
  const dollars = has('rate');
  const bills = dollars && has('total');
  const cols = est.scenarios.map(s => s.name);
  const per = (fn) => est.scenarios.map(fn);
  const sections = [];
  sections.push({ title: 'Your home now', rows: [
    ['Power used', per(() => `${roiKwh(m.annualKwh)} a year (${m.dailyKwh} kWh a day)`)],
    ...(bills ? [['Bills now', per(s => `${money(s.billNow)} a year${s.billNowIsActual ? '' : ' (at these rates)'}`)]] : []),
  ] });
  if (est.newSolarKw > 0) {
    sections.push({ title: `Step 1: ${est.newSolarKw} kW of solar${est.existingKw ? ` (on top of your ${est.existingKw} kW)` : ''}`, rows: [
      ['Solar generated', per(s => `${roiKwh(s.stages.solar.generation - s.stages.base.generation)} a year`)],
      ['Used straight away', per(s => `${roiKwh(s.stages.solar.selfUse)} a year`)],
      ['Sent to the grid', per(s => `${roiKwh(s.stages.solar.exported)} a year at ${s.plan.feed_in} c/kWh`)],
      ['Still bought from the grid', per(s => `${roiKwh(s.stages.solar.imported)} a year`)],
      ...(dollars ? [
        ['Saving from the solar', per(s => `${money(s.solarSaving)} a year`)],
        ...(est.prices.solar != null && est.prices.solar > 0 ? [['Solar pays for itself in', per(s => s.solarPayback ? `${s.solarPayback} years (${money(est.prices.solar)})` : 'more than 25 years')]] : []),
      ] : []),
    ] });
  }
  if (est.batteryKwh > 0) {
    sections.push({ title: `Step ${est.newSolarKw > 0 ? 2 : 1}: adding the ${est.batteryKwh} kWh battery`, rows: [
      ['Stored instead of exported', per(s => `${roiKwh(s.stages.full.charged)} a year`)],
      ['Used at night from the battery', per(s => `${roiKwh(s.stages.full.discharged)} a year`)],
      ...(est.exportWindow ? [['Sold from the battery', per(s => `${roiKwh(s.stages.full.batteryExport)} a year at ${s.stages.full.exportRate} c/kWh (${est.exportWindow.from || '17:00'} to ${est.exportWindow.to || '21:00'})`)]] : []),
      ['Still bought from the grid', per(s => `${roiKwh(s.stages.full.imported)} a year`)],
      ...(dollars ? [
        ['Extra saving from the battery', per(s => `${money(s.batterySaving)} a year`)],
        ...(est.prices.battery != null && est.prices.battery > 0 ? [['Battery pays for itself in', per(s => s.batteryPayback ? `${s.batteryPayback} years (${money(est.prices.battery)})` : 'more than 25 years')]] : []),
      ] : []),
    ] });
  }
  if (dollars) {
    sections.push({ title: 'Together', rows: [
      ...(bills ? [['Bills after', per(s => s.billAfter < 0 ? `in credit by ${money(-s.billAfter)} a year` : `${money(s.billAfter)} a year`)]] : []),
      ['Total saving', per(s => `${money(s.totalSaving)} a year`)],
      ...(est.prices.total > 0 ? [
        ['Your investment', per(() => `${money(est.prices.total)} after the credits`)],
        ['Pays for itself in', per(s => s.payback ? `${s.payback} years` : 'more than 25 years')],
        ['Yearly return', per(s => s.returnPercent != null ? `${s.returnPercent}% of the investment` : '-')],
      ] : []),
      ['Saving over 10 years', per(s => money(s.saving10))],
      ['Saving over 25 years', per(s => money(s.saving25))],
      ['Emissions avoided', per(s => `about ${s.co2TonnesPerYear} tonnes of CO2 a year`)],
    ] });
  }
  const rows = sections.flatMap(sec => sec.rows.map(([k, v]) => [k, v[0]]));
  return { gaps, asks, sections, columns: cols, est, metrics: m, dollars, bills, rows, checks: roiChecks({ ...checkArgs, est }) };
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
      rows.push([label, `${st.solarKw ? `${st.solarKw} kW makes ${roiKwh(st.generation)}; ` : ''}used straight ${roiKwh(st.selfUse)}${st.batteryKwh ? `; battery charged ${roiKwh(st.charged)}, gave back ${roiKwh(st.discharged)}${plan.tariff === 'tou' ? ` (${Object.entries(st.dischargedBy).filter(([, v]) => v > 0).map(([b, v]) => `${plan.bandLabel[b].toLowerCase()} ${roiKwh(v)}`).join(', ')})` : ''}${st.batteryExport ? `, sold ${roiKwh(st.batteryExport)} at ${st.exportRate} c` : ''}` : ''}; exported ${roiKwh(st.exported)}; bought ${imp || '0 kWh'}${st.controlledKwh ? `; controlled load ${roiKwh(st.controlledKwh)}` : ''}. Bill: usage ${money(st.usageCost)}${st.controlledCost ? ` + controlled ${money(st.controlledCost)}` : ''} + supply ${money(st.supplyCost)} - feed-in ${money(st.feedInCredit)}${st.batteryExportCredit ? ` - battery sales ${money(st.batteryExportCredit)}` : ''} = ${money(st.bill)} a year`]);
    });
    if (s.billNowIsActual && s.modelledNow) {
      const diff = Math.round(100 * (s.modelledNow - s.billNow) / s.billNow);
      rows.push(['Check', `The bill says ${money(s.billNow)} a year; these rates on this usage give ${money(s.modelledNow)} (${diff > 0 ? '+' : ''}${diff}%).${Math.abs(diff) > 20 ? ' More than 20% apart: check the rates, the times, the split and the controlled load.' : ''}`]);
    }
  });
  return out;
}

// ---------- charts ----------

const ROI_CHART_COLORS = { solar: '#1a6be6', battery: '#15803d', grid: '#5b6472', ink: '#0a0a0a', muted: '#5b6472', line: '#d9dde5' };

// Three small pictures for the proposal and the quote page preview, as inline SVG so the PDF gets
// them too: the yearly bill at each step, where the home's power will come from, and the savings
// adding up against the investment. Kept plain: a few marks, direct labels, one colour per thing
// (solar blue, battery green, grid grey as the neutral remainder). Drawn for the current plan.
function roiChartsHtml(est, money, { dollars = true, bills = true, colors = ROI_CHART_COLORS } = {}) {
  if (!est || !est.current) return '';
  const s = est.current;
  const c = colors;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const font = `font-family: Archivo, Helvetica, Arial, sans-serif;`;
  const charts = [];

  if (dollars && bills) {
    const bars = [{ label: 'Now', v: s.billNow, color: c.grid }];
    if (est.newSolarKw > 0) bars.push({ label: 'With solar', v: s.billWithSolar, color: c.solar });
    if (est.batteryKwh > 0) bars.push({ label: est.newSolarKw > 0 ? 'Solar + battery' : 'With battery', v: s.billAfter, color: c.battery });
    const max = Math.max(...bars.map(b => Math.max(0, b.v)), 1);
    const h = (v) => Math.max(2, Math.round(110 * Math.max(0, v) / max));
    bars.forEach(b => { b.text = b.v < 0 ? `${money(-b.v)} credit` : money(b.v); });
    const slot = 200 / bars.length;
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Your yearly bill</figcaption>
        <svg viewBox="0 0 220 170" width="100%" role="img" aria-label="${esc(bars.map(b => `${b.label} ${b.text}`).join(', '))}">
          <line x1="10" y1="140" x2="210" y2="140" stroke="${c.line}" stroke-width="1" />
          ${bars.map((b, i) => { const x = 10 + slot * i + slot / 2; return `<rect x="${x - 22}" y="${140 - h(b.v)}" width="44" height="${h(b.v)}" rx="4" fill="${b.color}" /><text x="${x}" y="${140 - h(b.v) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${c.ink}" style="${font}">${esc(b.text)}</text><text x="${x}" y="158" text-anchor="middle" font-size="10.5" fill="${c.muted}" style="${font}">${esc(b.label)}</text>`; }).join('')}
        </svg>
      </figure>`);
  }

  const full = s.stages.full;
  const use = Math.max(est.metrics.annualKwh, 1);
  const parts = [
    { label: 'Straight from the solar', kwh: full.selfUse, color: c.solar },
    { label: 'From the battery at night', kwh: full.discharged, color: c.battery },
    { label: 'Still from the grid', kwh: full.imported + full.controlledKwh, color: c.grid },
  ].filter(p => p.kwh > 0);
  const total = parts.reduce((a, p) => a + p.kwh, 0) || 1;
  let x = 10;
  const segs = parts.map((p, i) => {
    const w = Math.max(0, Math.round(200 * p.kwh / total) - (i < parts.length - 1 ? 2 : 0));
    const out = `<rect x="${x}" y="30" width="${w}" height="28" rx="${i === 0 || i === parts.length - 1 ? 4 : 0}" fill="${p.color}" />`;
    x += w + 2;
    return out;
  }).join('');
  const legend = parts.map((p, i) => `<g transform="translate(10, ${78 + i * 20})"><rect x="0" y="-9" width="12" height="12" rx="3" fill="${p.color}" /><text x="18" y="1" font-size="11.5" fill="${c.ink}" style="${font}">${esc(p.label)}: ${Math.round(100 * p.kwh / total)}%</text></g>`).join('');
  charts.push(`
      <figure class="roi-fig">
        <figcaption>Where your power comes from</figcaption>
        <svg viewBox="0 0 220 ${80 + parts.length * 20}" width="100%" role="img" aria-label="${esc(parts.map(p => `${p.label} ${Math.round(100 * p.kwh / total)}%`).join(', '))}">
          <text x="10" y="18" font-size="11" fill="${c.muted}" style="${font}">Of the ${Math.round(use).toLocaleString('en-AU')} kWh you use a year</text>
          ${segs}
          ${legend}
        </svg>
      </figure>`);

  if (dollars && est.prices.total > 0 && s.cumulative) {
    const cum = s.cumulative;
    const maxV = Math.max(cum[25], est.prices.total, 1);
    const X = (y) => 36 + Math.round(y * 170 / 25);
    const Y = (v) => 130 - Math.round(110 * v / maxV);
    const path = cum.map((v, y) => `${y === 0 ? 'M' : 'L'}${X(y)},${Y(v)}`).join(' ');
    const pb = s.payback && s.payback <= 25 ? s.payback : null;
    // the payback and the investment sit under the plot, so no label can collide with the line
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Savings add up</figcaption>
        <svg viewBox="0 0 220 186" width="100%" role="img" aria-label="Savings reach ${esc(money(cum[10]))} after 10 years and ${esc(money(cum[25]))} after 25 years against an investment of ${esc(money(est.prices.total))}${pb ? `, paid off in year ${esc(Math.ceil(pb))}` : ''}">
          <line x1="36" y1="130" x2="206" y2="130" stroke="${c.line}" stroke-width="1" />
          <line x1="36" y1="${Y(est.prices.total)}" x2="206" y2="${Y(est.prices.total)}" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" />
          <path d="${path}" fill="none" stroke="${c.solar}" stroke-width="2" stroke-linejoin="round" />
          ${pb ? `<circle cx="${X(pb)}" cy="${Y(est.prices.total)}" r="5" fill="${c.solar}" stroke="#fff" stroke-width="2" />` : ''}
          <circle cx="${X(25)}" cy="${Y(cum[25])}" r="4" fill="${c.solar}" stroke="#fff" stroke-width="2" />
          <text x="${X(25)}" y="${Y(cum[25]) - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${esc(money(cum[25]))}</text>
          <text x="36" y="146" font-size="10.5" fill="${c.muted}" style="${font}">Today</text>
          <text x="${X(10)}" y="146" text-anchor="middle" font-size="10.5" fill="${c.muted}" style="${font}">10 years</text>
          <text x="206" y="146" text-anchor="end" font-size="10.5" fill="${c.muted}" style="${font}">25 years</text>
          <text x="10" y="166" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${pb ? `Paid off in year ${esc(Math.ceil(pb))}` : 'Not paid off in 25 years'}</text>
          <g transform="translate(10, 179)"><line x1="0" y1="-4" x2="14" y2="-4" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" /><text x="20" y="0" font-size="10.5" fill="${c.muted}" style="${font}">Investment ${esc(money(est.prices.total))}</text></g>
        </svg>
      </figure>`);
  }
  return `<div class="roi-charts">${charts.join('')}</div>`;
}

function roiAssumptionsText(est) {
  const a = ROI_ASSUMPTIONS;
  const p = est.current.plan;
  const rateText = p.tariff === 'tou' ? `${ROI_BANDS.filter(b => (p.bandShare[b.key] || 0) > 0).map(b => `${b.label.toLowerCase()} ${p[b.key]} c/kWh`).join(', ')} (${roiScheduleText(p).toLowerCase()})` : `${p.rate} c/kWh`;
  return `Estimates only, worked out hour by hour on a typical day in each season from your electricity bill: ${est.yieldPerKw} kWh generated per kW of panels per day on average over the year, electricity bought at ${rateText}${p.feedInKnown ? ` and sold at ${p.feed_in} c/kWh as shown on your bill` : ` and sold at ${p.feed_in} c/kWh`}${est.exportWindow ? `, the battery selling to the grid at ${est.exportWindow.rate} c/kWh between ${est.exportWindow.from || '17:00'} and ${est.exportWindow.to || '21:00'}` : ''}, prices rising ${Math.round(a.priceRisePerYear * 100)}% a year, panels losing ${a.panelDegradationPerYear * 100}% of output a year${est.batteryKwh ? `, the battery at ${Math.round(a.batteryRoundTrip * 100)}% round trip efficiency` : ''}. Actual savings depend on weather, how and when you use power, and your retailer's rates.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROI_ASSUMPTIONS, ROI_BANDS, ROI_BAND_LABEL, billMetrics, suggestSizes, existingSolarKw, roiPlan, roiParseHours, roiParseMonths, roiBillWindows, roiCleanWindows, roiScheduleText, roiScheduleStripHtml, roiBatteryKwhFromLines, roiDefaultPrices, roiPricesFor, roiEstimate, roiGaps, roiChecks, roiPresentation, roiWorkingRows, roiChartsHtml, roiAssumptionsText };
}
