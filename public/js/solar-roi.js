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

// ---------- rates (a plan) ----------

// "14:00-20:00, 07:00-09:00" to a set of hours. A window that crosses midnight wraps.
function roiParseHours(text) {
  const hours = new Set();
  String(text || '').split(/[,;]/).forEach(part => {
    const m = part.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?$/i);
    if (!m) return;
    const from = parseInt(m[1], 10) % 24;
    let to = parseInt(m[3], 10);
    if (to === 24) to = 0;
    to = to % 24;
    if (from === to) { for (let h = 0; h < 24; h++) hours.add(h); return; }
    for (let h = from; h !== to; h = (h + 1) % 24) hours.add(h);
  });
  return hours;
}

// The rates a plan charges, with the bill's figures as the fallback for anything not typed.
// Fields: tariff ('flat' | 'tou'), rate, peak, shoulder, off_peak, controlled, peak_hours,
// shoulder_hours, supply, feed_in, name.
function roiPlan(saved, reading, fallbackName) {
  const r = reading || {};
  const s = saved || {};
  const rates = r.usage_rates || {};
  const billTou = !!(roiNum(rates.peak) && (roiNum(rates.off_peak) != null)) || r.tariff_type === 'time_of_use';
  const tariff = s.tariff || (billTou && roiNum(rates.peak) ? 'tou' : 'flat');
  const pick = (k, billValue) => (roiNum(s[k]) != null ? roiNum(s[k]) : roiNum(billValue));
  const plan = {
    name: s.name || fallbackName,
    tariff,
    rate: pick('rate', r.usage_rate_c_per_kwh),
    peak: pick('peak', rates.peak),
    shoulder: pick('shoulder', rates.shoulder),
    off_peak: pick('off_peak', rates.off_peak),
    controlled: pick('controlled', rates.controlled_load),
    supply: pick('supply', r.supply_charge_c_per_day),
    feed_in: pick('feed_in', r.feed_in_c_per_kwh),
    peak_hours: s.peak_hours || ROI_ASSUMPTIONS.defaultPeakHours,
    shoulder_hours: s.shoulder_hours || ROI_ASSUMPTIONS.defaultShoulderHours,
  };
  if (plan.tariff === 'tou') {
    if (plan.peak == null) plan.peak = plan.rate;
    if (plan.off_peak == null) plan.off_peak = plan.rate != null ? Math.round(plan.rate * 0.7 * 10) / 10 : null;
    if (plan.shoulder == null && plan.peak != null && plan.off_peak != null) plan.shoulder = Math.round((plan.peak + plan.off_peak) / 2 * 10) / 10;
  } else if (plan.rate == null && plan.peak != null) {
    plan.rate = plan.peak;
  }
  if (plan.controlled == null) plan.controlled = plan.tariff === 'tou' ? plan.off_peak : plan.rate;
  plan.hasRate = plan.tariff === 'tou' ? (plan.peak != null && plan.off_peak != null) : plan.rate != null;
  plan.feedInKnown = plan.feed_in != null;
  if (plan.feed_in == null) plan.feed_in = ROI_ASSUMPTIONS.defaultFeedInCents;
  plan.supplyKnown = plan.supply != null;
  if (plan.supply == null) plan.supply = ROI_ASSUMPTIONS.defaultSupplyChargeCents;
  const peakHours = roiParseHours(plan.peak_hours);
  const shoulderHours = roiParseHours(plan.shoulder_hours);
  plan.bandOf = (h) => (plan.tariff !== 'tou' ? 'flat' : peakHours.has(h) ? 'peak' : shoulderHours.has(h) ? 'shoulder' : 'off_peak');
  plan.rateOf = (h) => { const b = plan.bandOf(h); return b === 'flat' ? plan.rate : plan[b]; };
  plan.bandLabel = { flat: 'Usage', peak: 'Peak', shoulder: 'Shoulder', off_peak: 'Off-peak' };
  return plan;
}

// The hourly load shape, stretched so the hours in each band add up to the bill's split.
function roiLoadShape(metrics, plan) {
  const base = ROI_ASSUMPTIONS.loadShape.slice();
  const total = base.reduce((s, v) => s + v, 0);
  let shape = base.map(v => v / total);
  if (metrics.split && plan.tariff === 'tou') {
    const splitTotal = metrics.split.peak + metrics.split.shoulder + metrics.split.offPeak;
    if (splitTotal > 0) {
      const want = { peak: metrics.split.peak / splitTotal, shoulder: metrics.split.shoulder / splitTotal, off_peak: metrics.split.offPeak / splitTotal };
      const have = { peak: 0, shoulder: 0, off_peak: 0 };
      shape.forEach((v, h) => { have[plan.bandOf(h)] += v; });
      shape = shape.map((v, h) => { const b = plan.bandOf(h); return have[b] > 0 ? v * want[b] / have[b] : v; });
      const sum = shape.reduce((s, v) => s + v, 0);
      shape = shape.map(v => v / sum);
    }
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
function roiRunStage({ metrics, plan, loadShape, solarShape, solarKw, batteryKwh, yieldPerKw, exportWindow }) {
  const dailyGeneral = Math.max(0, (metrics.dailyKwh || 0) - (metrics.controlledDailyKwh || 0));
  const eff = Math.sqrt(ROI_ASSUMPTIONS.batteryRoundTrip);
  const cRate = batteryKwh * ROI_ASSUMPTIONS.batteryMaxChargeC;
  const exp = exportWindow && exportWindow.enabled && roiNum(exportWindow.rate) > 0 ? {
    hours: roiParseHours(`${exportWindow.from || '17:00'}-${exportWindow.to || '21:00'}`),
    rate: roiNum(exportWindow.rate),
    maxKwh: roiNum(exportWindow.max_kwh) || batteryKwh,
  } : null;
  const totals = { generation: 0, selfUse: 0, charged: 0, discharged: 0, batteryExport: 0, exported: 0, imported: 0, importBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0 }, load: 0 };
  ROI_ASSUMPTIONS.seasons.forEach(season => ROI_ASSUMPTIONS.dayTypes.forEach(dayType => {
    const daysPerSeason = 365 / ROI_ASSUMPTIONS.seasons.length * dayType.share;
    let soc = 0;
    let exportLeft = exp ? exp.maxKwh : 0;
    // start at 6am so the battery begins the solar day empty, run a full day
    for (let i = 0; i < 24; i++) {
      const h = (6 + i) % 24;
      if (h === 0) exportLeft = exp ? exp.maxKwh : 0;
      const load = dailyGeneral * loadShape[h] * season.load;
      const gen = solarKw * yieldPerKw * season.gen * dayType.gen * solarShape[h];
      const self = Math.min(gen, load);
      let surplus = gen - self;
      let deficit = load - self;
      totals.generation += gen * daysPerSeason;
      totals.selfUse += self * daysPerSeason;
      totals.load += load * daysPerSeason;
      if (batteryKwh > 0) {
        const charge = Math.min(surplus, Math.max(0, batteryKwh - soc) / eff, cRate);
        soc += charge * eff;
        surplus -= charge;
        totals.charged += charge * daysPerSeason;
        let out = 0;
        if (exp && exp.hours.has(h) && exportLeft > 0 && exp.rate > plan.rateOf(h)) {
          const e = Math.min(soc * eff, exportLeft, cRate);
          soc -= e / eff;
          exportLeft -= e;
          out += e;
          totals.batteryExport += e * daysPerSeason;
        }
        const discharge = Math.min(deficit, soc * eff, Math.max(0, cRate - out));
        soc -= discharge / eff;
        deficit -= discharge;
        totals.discharged += discharge * daysPerSeason;
      }
      totals.exported += surplus * daysPerSeason;
      totals.imported += deficit * daysPerSeason;
      totals.importBy[plan.bandOf(h)] += deficit * daysPerSeason;
    }
  }));
  const controlledKwh = (metrics.controlledDailyKwh || 0) * 365;
  const usageCost = Object.keys(totals.importBy).reduce((s, b) => s + totals.importBy[b] * (b === 'flat' ? plan.rate : plan[b]) / 100, 0);
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
  if (hasBattery && !(roiNum(batteryKwh) > 0)) gaps.push({ key: 'battery', blocking: false, staff: 'No battery quoted on step 3, so the estimate runs without one. Type the battery quoted (usable kWh) there, or answer "Batteries as well?" No if this quote has no battery.', client: null });
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

// ---------- presentation ----------

const roiKwh = (n) => `${Math.round(n).toLocaleString('en-AU')} kWh`;

// Everything the proposal (and the quote page preview) shows: the sections and rows we can stand
// behind with what we have (one value per plan), the asks ("to give you Y, we need X") for what the
// customer can supply, the staff-side gaps and the working. Nothing is withheld that we do have;
// nothing is shown that rests on a guess: no rates means kWh rows only, no bill total means no
// "bills now and after", no existing solar size when the bill shows export means use only.
function roiPresentation({ reading, answers, template, newSolarKw, batteryKwh, netCost, zoneRating, money, inputs, solarPrice, batteryPrice }) {
  const gaps = roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice });
  const has = (k) => !gaps.some(g => g.key === k);
  const asks = gaps.filter(g => g.client).map(g => ({ key: g.key, need: g.client, gives: ROI_GAP_GIVES[g.key] || 'a more accurate estimate', blocking: g.blocking }));
  const m = billMetrics(reading);
  const empty = { gaps, asks, sections: [], columns: [], est: null, metrics: m, dollars: false, rows: [] };
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
  return { gaps, asks, sections, columns: cols, est, metrics: m, dollars, bills, rows };
}

// The working for the staff: each stage's kWh and dollars on each plan, as rows.
function roiWorkingRows(est, money) {
  if (!est) return [];
  const out = [];
  est.scenarios.forEach(s => {
    const plan = s.plan;
    const rateText = plan.tariff === 'tou' ? `peak ${plan.peak}, shoulder ${plan.shoulder}, off-peak ${plan.off_peak} c/kWh` : `${plan.rate} c/kWh`;
    out.push({ title: `${s.name}: ${rateText}, supply ${plan.supply} c/day, feed-in ${plan.feed_in} c/kWh${plan.tariff === 'tou' ? ` (peak ${plan.peak_hours}; shoulder ${plan.shoulder_hours})` : ''}`, rows: [] });
    const stages = [['As the home is now', s.stages.base], ...(est.newSolarKw > 0 ? [['With the solar', s.stages.solar]] : []), ...(est.batteryKwh > 0 ? [['With the solar and the battery', s.stages.full]] : [])];
    stages.forEach(([label, st]) => {
      const imp = Object.entries(st.importBy).filter(([, v]) => v > 0).map(([b, v]) => `${plan.bandLabel[b].toLowerCase()} ${roiKwh(v)}`).join(', ');
      out[out.length - 1].rows.push([label, `${st.solarKw ? `${st.solarKw} kW makes ${roiKwh(st.generation)}; ` : ''}used straight ${roiKwh(st.selfUse)}${st.batteryKwh ? `; battery charged ${roiKwh(st.charged)}, gave back ${roiKwh(st.discharged)}${st.batteryExport ? `, sold ${roiKwh(st.batteryExport)} at ${st.exportRate} c` : ''}` : ''}; exported ${roiKwh(st.exported)}; bought ${imp || '0 kWh'}${st.controlledKwh ? `; controlled load ${roiKwh(st.controlledKwh)}` : ''}. Bill: usage ${money(st.usageCost)}${st.controlledCost ? ` + controlled ${money(st.controlledCost)}` : ''} + supply ${money(st.supplyCost)} - feed-in ${money(st.feedInCredit)}${st.batteryExportCredit ? ` - battery sales ${money(st.batteryExportCredit)}` : ''} = ${money(st.bill)} a year`]);
    });
    if (s.billNowIsActual && s.modelledNow) {
      const diff = Math.round(100 * (s.modelledNow - s.billNow) / s.billNow);
      out[out.length - 1].rows.push(['Check', `The bill says ${money(s.billNow)} a year; these rates on this usage give ${money(s.modelledNow)} (${diff > 0 ? '+' : ''}${diff}%).${Math.abs(diff) > 20 ? ' More than 20% apart: check the rates, the split and the controlled load.' : ''}`]);
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
    const lx = pb ? (X(pb) <= 100 ? X(pb) + 9 : 206) : 36;
    const anchor = pb && X(pb) <= 100 ? 'start' : (pb ? 'end' : 'start');
    const ly = pb ? Math.min(Y(est.prices.total) + 15, 126) : 100;
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Savings add up</figcaption>
        <svg viewBox="0 0 220 170" width="100%" role="img" aria-label="Savings reach ${esc(money(cum[10]))} after 10 years and ${esc(money(cum[25]))} after 25 years against an investment of ${esc(money(est.prices.total))}">
          <line x1="36" y1="130" x2="206" y2="130" stroke="${c.line}" stroke-width="1" />
          <line x1="36" y1="${Y(est.prices.total)}" x2="206" y2="${Y(est.prices.total)}" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" />
          <path d="${path}" fill="none" stroke="${c.solar}" stroke-width="2" stroke-linejoin="round" />
          ${pb ? `<circle cx="${X(pb)}" cy="${Y(est.prices.total)}" r="5" fill="${c.solar}" stroke="#fff" stroke-width="2" />` : ''}
          <text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="10.5" fill="${c.ink}" style="${font}"><tspan x="${lx}" font-weight="600">${pb ? `Paid off in year ${esc(Math.ceil(pb))}` : 'Not paid off in 25 years'}</tspan><tspan x="${lx}" dy="13" fill="${c.muted}">Investment ${esc(money(est.prices.total))}</tspan></text>
          <circle cx="${X(25)}" cy="${Y(cum[25])}" r="4" fill="${c.solar}" stroke="#fff" stroke-width="2" />
          <text x="${X(25)}" y="${Y(cum[25]) - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${esc(money(cum[25]))}</text>
          <text x="36" y="158" font-size="10.5" fill="${c.muted}" style="${font}">Today</text>
          <text x="${X(10)}" y="158" text-anchor="middle" font-size="10.5" fill="${c.muted}" style="${font}">10 years</text>
          <text x="206" y="158" text-anchor="end" font-size="10.5" fill="${c.muted}" style="${font}">25 years</text>
        </svg>
      </figure>`);
  }
  return `<div class="roi-charts">${charts.join('')}</div>`;
}

function roiAssumptionsText(est) {
  const a = ROI_ASSUMPTIONS;
  const p = est.current.plan;
  const rateText = p.tariff === 'tou' ? `peak ${p.peak} c/kWh (${p.peak_hours}), shoulder ${p.shoulder} c/kWh and off-peak ${p.off_peak} c/kWh` : `${p.rate} c/kWh`;
  return `Estimates only, worked out hour by hour on a typical day in each season from your electricity bill: ${est.yieldPerKw} kWh generated per kW of panels per day on average over the year, electricity bought at ${rateText}${p.feedInKnown ? ` and sold at ${p.feed_in} c/kWh as shown on your bill` : ` and sold at ${p.feed_in} c/kWh`}${est.exportWindow ? `, the battery selling to the grid at ${est.exportWindow.rate} c/kWh between ${est.exportWindow.from || '17:00'} and ${est.exportWindow.to || '21:00'}` : ''}, prices rising ${Math.round(a.priceRisePerYear * 100)}% a year, panels losing ${a.panelDegradationPerYear * 100}% of output a year${est.batteryKwh ? `, the battery at ${Math.round(a.batteryRoundTrip * 100)}% round trip efficiency` : ''}. Actual savings depend on weather, how and when you use power, and your retailer's rates.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROI_ASSUMPTIONS, billMetrics, suggestSizes, existingSolarKw, roiPlan, roiParseHours, roiEstimate, roiGaps, roiPresentation, roiWorkingRows, roiChartsHtml, roiAssumptionsText };
}
