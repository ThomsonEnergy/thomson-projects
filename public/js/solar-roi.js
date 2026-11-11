// The savings estimate shown on a proposal. One file shared by the browser (the quote page's
// preview, the client's proposal) and the functions, so the staff and the client see the same
// maths. Plain script plus the module.exports guard at the bottom: no DOM access at load time.
// The size suggestion is in solar-sizing.js; the staff-only checks are in solar-roi-staff.js.
//
// Inputs: the reading of the customer's electricity bill (projects.bill_reading), projects.roi_inputs
// (the rates, a second plan, night charging, a battery export window, and this quote's assumed
// values and overrides), the quoted solar kW, battery kWh and prices. Every figure is an estimate
// from the assumptions below, and the proposal lists them. docs/IDEAS_BACKLOG.md items 29 and 72.
//
// How it is worked out: the home is fixed once (roiHome), then each stage (as it is now, with the
// solar, with the solar and the battery) is run hour by hour and billed at the plan's rates
// (roiRunStage), so each step's saving is its own difference (roiEstimate).

const ROI_ASSUMPTIONS = {
  // kWh a day from each kW of panels by STC zone rating: the year's average, cloudy days and normal
  // losses already in it (Clean Energy Council guide figures: Sydney 3.9, Brisbane 4.2). Zone 3
  // runs from Sydney to Cairns, so its Queensland (4000 to 4999) and Northern Rivers (2460 to 2490)
  // postcodes take the northern figure (roiSiteYield).
  yieldPerKwPerDay: { 1.622: 4.4, 1.536: 4.2, 1.382: 3.9, 1.185: 3.5 },
  northYieldPerKwPerDay: 4.2,
  defaultZoneRating: 1.382,
  batteryRoundTrip: 0.90,     // kWh out per kWh in (split evenly between charging and discharging)
  batteryMaxChargeC: 0.5,     // charges or discharges at most half its usable capacity in an hour
  priceRisePerYear: 0.03,     // electricity price growth for the "if prices rise" figures (the main figures stay at today's prices)
  batteryLifeYears: 15,       // the battery's saving is counted for this many years in the long-run figures
  panelDegradationPerYear: 0.005,
  gridEmissionsKgPerKwh: 0.68, // NSW grid average
  defaultUsageRateCents: 33,
  defaultFeedInCents: 5,
  defaultSupplyChargeCents: 110,
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
  // a payback longer than this is "Not paid off in 25 years" everywhere (F32)
  paybackCapYears: 25,
};

// ---------- what the estimate assumes on this quote ----------

// The assumed values in use: the normal ones above, with any changed for this quote (kept under
// roi_inputs.assumptions by key; backlog item 72) laid over them. A value outside its sensible
// range is ignored. The two kinds of day and the four seasons are kept averaging to the year.
// The normal sun figure for a site (see ROI_ASSUMPTIONS.yieldPerKwPerDay). address is the quote's
// site address: the four digits it ends on (before "Australia", if that is there) are the postcode.
// A street number is never taken for one; an address with no postcode keeps the zone's figure.
function roiSiteYield(zoneRating, address) {
  const A = ROI_ASSUMPTIONS;
  const zone = A.yieldPerKwPerDay[zoneRating] ? Number(zoneRating) : A.defaultZoneRating;
  const pc = Number((String(address || '').match(/\b(\d{4})(?:\s*,?\s*Australia)?\s*$/i) || [])[1]);
  const north = (pc >= 4000 && pc <= 4999) || (pc >= 2460 && pc <= 2490);
  return zone === A.defaultZoneRating && north ? A.northYieldPerKwPerDay : A.yieldPerKwPerDay[zone];
}

// The site's own sun figures (projects.site_sun, item 75: ten years of daily sun records for the
// spot, worked out by netlify/functions/site-sun.js), when they are for this address and every
// figure is believable; null otherwise, and the zone's figures are used.
function roiSiteSun(siteSun, siteAddress) {
  const s = siteSun;
  if (!s || typeof s !== 'object' || String(s.for_address || '').trim() !== String(siteAddress || '').trim()) return null;
  const y = roiNum(s.yield_per_kw), c = roiNum(s.clear_share), o = roiNum(s.overcast_output);
  const seasons = Array.isArray(s.seasons) && s.seasons.length === 4 ? s.seasons.map(roiNum) : [];
  if (!(y >= 2.5 && y <= 6 && c >= 0.3 && c <= 1 && o >= 0 && o <= 0.9) || seasons.length !== 4 || !seasons.every(v => v >= 0.3 && v <= 1.8)) return null;
  return { yield: y, clearShare: c, overcastGen: o, seasons, years: String(s.years || '') };
}

function roiSettings(inputs, zoneRating, siteAddress, siteSun) {
  const A = ROI_ASSUMPTIONS;
  const typed = (inputs && typeof inputs.assumptions === 'object' && inputs.assumptions) || {};
  const num = (key, min, max) => { const n = roiNum(typed[key]); return n != null && n >= min && n <= max ? n : null; };
  const site = roiSiteSun(siteSun, siteAddress);
  const zoneYield = site ? site.yield : roiSiteYield(zoneRating, siteAddress);
  const clearShare = num('clear_day_share', 0.3, 1) ?? (site ? site.clearShare : A.dayTypes[0].share);
  const overcastGen = num('overcast_output', 0, 0.9) ?? (site ? site.overcastGen : A.dayTypes[1].gen);
  // a clear day is lifted so that the clear and the overcast days still average to the yearly yield
  const dayTypes = clearShare >= 0.999 ? [{ name: 'clear', share: 1, gen: 1 }]
    : [{ name: 'clear', share: clearShare, gen: (1 - (1 - clearShare) * overcastGen) / clearShare }, { name: 'overcast', share: 1 - clearShare, gen: overcastGen }];
  const raw = A.seasons.map((sn, i) => ({ name: sn.name, gen: num(`season_gen_${i}`, 0.2, 2) ?? (site ? site.seasons[i] : sn.gen), load: num(`season_load_${i}`, 0.2, 2) ?? sn.load }));
  const mean = (k) => raw.reduce((t, sn) => t + sn[k], 0) / raw.length;
  const meanGen = mean('gen'), meanLoad = mean('load');
  return {
    yieldPerKw: num('yield_per_kw', 1, 7) ?? zoneYield, zoneYield,
    sunRecords: site ? site.years || 'ten years' : null, // the years of records behind the sun figures, or null for the zone's
    clearShare, overcastGen, dayTypes,
    seasons: raw.map(sn => ({ name: sn.name, gen: sn.gen / meanGen, load: sn.load / meanLoad })),
    daylightShare: num('daylight_share', 0.1, 0.9), // null: the normal household day
    annualKwh: num('annual_kwh', 100, 5000000),      // null: the bill's own figure
    batteryRoundTrip: num('battery_round_trip', 0.5, 1) ?? A.batteryRoundTrip,
    batteryMaxChargeC: num('battery_charge_rate', 0.1, 2) ?? A.batteryMaxChargeC,
    batteryLifeYears: Math.round(num('battery_life_years', 1, 25) ?? A.batteryLifeYears),
    priceRise: num('price_rise', 0, 0.15) ?? A.priceRisePerYear,
    panelLoss: num('panel_loss', 0, 0.05) ?? A.panelDegradationPerYear,
    emissions: num('grid_emissions', 0, 2) ?? A.gridEmissionsKgPerKwh,
    typed,
  };
}

// The export limit in kW, in total across the phases, from the step 1 answer: a typed number
// ("7.5", "7.5 kW", "7.5 kW total"), "Zero export" or "No export" (0), or none ("No limit", "Not
// known yet" or blank: null, and then no limit is applied and the proposal says so). Anything else
// ("5 kW per phase", "3 phase 15kW") is not guessed at: no limit is applied and
// roiExportLimitUnclear() tells the staff.
function roiExportLimitRead(answers) {
  const text = String((answers || {}).export_limit ?? '').trim().toLowerCase();
  if (!text || /^(no limit|none|unlimited|not known( yet)?|unknown)$/.test(text)) return { kw: null, unclear: false };
  if (/^(zero( export)?|no export|nil)$/.test(text)) return { kw: 0, unclear: false };
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(kw)?(\s*(in\s+)?total)?$/);
  // over 1,000 is watts typed for kW ("5000"): not guessed at either
  return m && parseFloat(m[1]) <= 1000 ? { kw: parseFloat(m[1]), unclear: false } : { kw: null, unclear: true };
}
const roiExportLimitKw = (answers) => roiExportLimitRead(answers).kw;
const roiExportLimitUnclear = (answers) => roiExportLimitRead(answers).unclear;

// True when the existing solar comes off the roof as part of this job, so it is counted in the home
// as it is now and not after. The step 1 answer "Existing system after this job" decides it. Where
// that is blank (an older quote), the words in the existing system answer are read ("1 kW, to be
// removed"; not "not removed"), on Solar quotes only: a Battery quote's battery couples to the
// existing solar. roiExistingRemovedFromWords() tells the staff when the words decided it.
const ROI_EXISTING_STAYS = 'Stays on the roof', ROI_EXISTING_GOES = 'Coming off the roof';
function roiExistingRemovedFromWords(answers, template) {
  const a = answers || {};
  if (a.existing_system === ROI_EXISTING_STAYS || a.existing_system === ROI_EXISTING_GOES || template === 'battery') return false;
  const text = `${a.existing_pv || ''} ${a.existing_system_detail || ''}`;
  const m = text.match(/\b(to be removed|being removed|will be removed|removing|remove (it|the|existing|old)|decommission\w*|coming off|taken (off|down))\b/i);
  if (!m) return false;
  return !/\b(not|no|never|isn['’]?t|won['’]?t|don['’]?t|do not|no need)\s+(to\s+)?(be\s+)?$/i.test(text.slice(0, m.index));
}
function roiExistingRemoved(answers, template) {
  const a = answers || {};
  if (a.existing_system === ROI_EXISTING_GOES) return true;
  if (a.existing_system === ROI_EXISTING_STAYS) return false;
  return roiExistingRemovedFromWords(a, template);
}

// ---------- GST basis of the bill (M10) ----------

// Business bills are usually printed ex GST, while every published plan (energy-plans.js) and the
// quote's price are inc GST. roi_inputs.bill_gst says which the bill is ('inc' or 'ex'); without it a
// company client's bill is taken as ex GST and a household's as inc GST. The estimate runs inc GST
// throughout, so an ex GST bill (its total, its rates and its supply charge) and the rates typed from
// it under the estimate's inputs are lifted by 10% here before anything is compared. The feed-in rate
// is left alone: feed-in credits carry no GST in the published plans either.
const ROI_GST = 1.1;
function roiBillGst(inputs, clientType) {
  const v = String((inputs || {}).bill_gst || '').toLowerCase();
  if (v === 'ex' || v === 'inc') return v;
  return clientType === 'company' ? 'ex' : 'inc';
}
function roiLiftGst(v) {
  const n = roiNum(v);
  return n == null ? v : Math.round(n * ROI_GST * 1000) / 1000;
}
function roiReadingIncGst(reading) {
  if (!reading) return reading;
  const rates = reading.usage_rates && typeof reading.usage_rates === 'object'
    ? Object.fromEntries(Object.entries(reading.usage_rates).map(([k, v]) => [k, roiLiftGst(v)]))
    : reading.usage_rates;
  return {
    ...reading,
    bill_total: roiLiftGst(reading.bill_total), usage_charges_total: roiLiftGst(reading.usage_charges_total),
    other_charges_total: roiLiftGst(reading.other_charges_total), // credits and rebates carry no GST
    usage_rate_c_per_kwh: roiLiftGst(reading.usage_rate_c_per_kwh), usage_rates: rates,
    supply_charge_c_per_day: roiLiftGst(reading.supply_charge_c_per_day),
  };
}
function roiInputsIncGst(inputs) {
  const inp = inputs || {};
  const plan = (s) => (s && typeof s === 'object'
    ? { ...s, rate: roiLiftGst(s.rate), peak: roiLiftGst(s.peak), shoulder: roiLiftGst(s.shoulder), off_peak: roiLiftGst(s.off_peak), solar_soak: roiLiftGst(s.solar_soak), controlled: roiLiftGst(s.controlled), supply: roiLiftGst(s.supply) }
    : s);
  const deal = (d) => (d && typeof d === 'object' ? { ...d, rate: roiLiftGst(d.rate) } : d);
  // Only what came off the bill is lifted: the current plan and the grid charge (a buy rate). The second
  // plan (alt) is a retailer's published offer typed in as is, inc GST already, and the export rate is a
  // credit, which carries no GST (like the feed-in tariff). bill_gst becomes 'inc' so a second pass over
  // the same inputs changes nothing.
  return { ...inp, bill_gst: 'inc', current: plan(inp.current), grid_charge: deal(inp.grid_charge) };
}
// Hard blocks shown anyway (roi_inputs.overrides, set on a quote's Savings assumptions page, item
// 72): the figure typed in a missing one's place is laid into the reading or the answers. Returns
// the reading and answers to use, `overridden` (the gap keys that no longer hold figures back) and
// `overrideNotes` ([label, words] for the proposal's "What we assumed", in the customer's words).
// Each override is { on, values, reason, by, at }; one without its figure does nothing.
function roiApplyOverrides(a) {
  const ov = (a.inputs && typeof a.inputs.overrides === 'object' && a.inputs.overrides) || {};
  const on = (k) => !!ov[k] && ov[k].on === true;
  const val = (k, f) => roiNum(((ov[k] || {}).values || {})[f]);
  let reading = a.reading || null, answers = a.answers || {};
  const overridden = [], notes = [];
  if (!reading) {
    const daily = val('bill', 'daily_kwh'), rate = val('bill', 'rate_c');
    if (on('bill') && daily > 0 && rate > 0) {
      reading = { daily_average_kwh: daily, usage_rate_c_per_kwh: rate, supply_charge_c_per_day: val('bill', 'supply_c'), feed_in_c_per_kwh: val('bill', 'feed_in_c'), tariff_type: 'flat', estimated: true };
      overridden.push('bill', 'usage', 'rate', 'total', 'short');
      notes.push(['Your electricity bill', `We did not have it. ${daily} kWh a day at ${rate} c/kWh is our estimate of your use and your rate`]);
    }
  } else {
    const daily = val('usage', 'daily_kwh');
    if (on('usage') && daily > 0 && !billMetrics(reading).dailyKwh) {
      reading = { ...reading, daily_average_kwh: daily };
      overridden.push('usage');
      notes.push(['Your use', `Not on the pages of your bill we have. ${daily} kWh a day is our estimate`]);
    }
    const rate = val('rate', 'rate_c');
    if (on('rate') && rate > 0 && !roiPlan((a.inputs || {}).current, reading, '').hasRate) {
      reading = { ...reading, usage_rate_c_per_kwh: rate };
      overridden.push('rate');
      notes.push(['Your rate', `Not on the pages of your bill we have. ${rate} c/kWh is our estimate`]);
    }
    if (on('total') && roiNum(reading.bill_total) == null) {
      overridden.push('total');
      notes.push(['Your bill total', 'Not on the pages of your bill we have, so your bills are worked out from your rates and your use']);
    }
  }
  if (on('existing') && reading && (billMetrics(reading).hasSolarAlready || a.template === 'battery') && !existingSolarKw(answers)) {
    const kw = val('existing', 'kw');
    overridden.push('existing');
    // the size goes in front of the words already there ("to be removed" still counts); the list says it is ours
    if (kw > 0) answers = { ...answers, existing_pv: `${kw} kW ${answers.existing_pv || ''}`.trim() };
    else notes.push(['Your existing solar', 'We do not have its size, so it is left out of these figures']);
  }
  return { reading, answers, overridden, overrideNotes: notes };
}

// The arguments of the public functions below, made ready once: any hard block the quote shows
// anyway is filled in (roiApplyOverrides), then the bill and the inputs are put on an inc GST basis,
// with billGst (what the bill was). Safe to call twice: once done the arguments carry billGst.
function roiIncGstArgs(args) {
  if (args && args.billGst) return args;
  const a = { ...(args || {}), ...roiApplyOverrides(args || {}) };
  const billGst = a.reading && a.reading.estimated ? 'inc' : roiBillGst(a.inputs, a.clientType);
  const billGstTyped = /^(ex|inc)$/i.test(String((a.inputs || {}).bill_gst || ''));
  if (billGst !== 'ex') return { ...a, billGst, billGstTyped };
  return { ...a, billGst, billGstTyped, reading: roiReadingIncGst(a.reading), inputs: roiInputsIncGst(a.inputs) };
}

function roiNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
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

// The existing solar in kW: the dedicated "Existing PV size" answer first, the free text only when that
// has no size. "kW" must not be the kW inside "kWh" ("10kWh battery and 6.6kW solar" is 6.6 kW) (M11).
function existingSolarKw(answers) {
  const a = answers || {};
  const kwIn = (text) => {
    const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*kw(?!h)/i);
    return m ? parseFloat(m[1]) : 0;
  };
  return kwIn(a.existing_pv) || kwIn(a.existing_system_detail);
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

// The hourly load shape, stretched so the hours in each band add up to the bill's split (or to
// bandKwh when given: roiHome passes the home's own use per band once existing solar is allowed
// for). Hours can be in different bands on weekdays and weekends or by season, so the stretch is
// fitted over the whole year (a few rounds of proportional fitting). Returns { shape, fitted }:
// fitted is false when the bill has no split or its bands and the plan's times do not line up, and
// then the shape is the normal household day (or the typed daylight share).
function roiLoadShape(metrics, plan, settings, bandKwh) {
  const base = ROI_ASSUMPTIONS.loadShape.slice();
  const total = base.reduce((s, v) => s + v, 0);
  let shape = base.map(v => v / total);
  // a typed share of the day's use in daylight (6am to 6pm) reshapes the normal household day to it
  const dayWant = settings ? settings.daylightShare : null;
  if (dayWant != null) {
    const dayNow = roiDaylightShare(shape);
    shape = shape.map((v, h) => (h >= 6 && h < 18 ? v * dayWant / dayNow : v * (1 - dayWant) / (1 - dayNow)));
  }
  if (!metrics.split || plan.tariff !== 'tou') return { shape, fitted: false };
  const sp = bandKwh || metrics.split;
  const want = { peak: sp.peak, shoulder: sp.shoulder, off_peak: sp.offPeak, solar_soak: sp.solarSoak || 0 };
  const splitTotal = Object.values(want).reduce((a, b) => a + b, 0);
  if (!(splitTotal > 0)) return { shape, fitted: false };
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
  if (!bandsUsed.every(b => want[b] > 0)) return { shape, fitted: false };
  for (let round = 0; round < 40; round++) {
    const have = { peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 };
    shape.forEach((v, h) => bandsUsed.forEach(b => { have[b] += v * mem[h][b]; }));
    const f = {};
    bandsUsed.forEach(b => { f[b] = have[b] > 0 ? want[b] / have[b] : 1; });
    shape = shape.map((v, h) => v * bandsUsed.reduce((s, b) => s + mem[h][b] * f[b], 0));
    const sum = shape.reduce((s, v) => s + v, 0);
    shape = shape.map(v => v / sum);
  }
  return { shape, fitted: true };
}

// The share of a day's use that falls between 6am and 6pm, the hours the panels work.
function roiDaylightShare(shape) {
  return shape.reduce((t, v, h) => t + (h >= 6 && h < 18 ? v : 0), 0);
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
// peak is still ahead), and carries what is left into the next morning: each kind of day is run
// until the charge it starts with stops changing, then counted.
// With gridCharge set, the battery may also charge from the grid in a window (a cheap night rate,
// say): only as much as it needs for dearer hours before the panels can refill it, and only where
// that pays after battery losses. It never charges from the grid and spends it in the same hour.
// exportLimitKw (null for none) caps what goes to the grid in any hour, from the panels and the
// battery together; spare solar over it is lost (curtailed). dailyKwh is the home's own use a day
// (roiHome); settings is roiSettings().
function roiRunStage({ metrics, plan, loadShape, solarShape, solarKw, batteryKwh, settings, dailyKwh, exportLimitKw, exportWindow, gridCharge }) {
  const S = settings;
  const dailyGeneral = Math.max(0, (dailyKwh != null ? dailyKwh : (metrics.dailyKwh || 0)) - (metrics.controlledDailyKwh || 0));
  const eff = Math.sqrt(S.batteryRoundTrip);
  const cRate = batteryKwh * S.batteryMaxChargeC;
  const cap = exportLimitKw != null && exportLimitKw >= 0 ? exportLimitKw : null; // kW, so kWh in each hour
  const exp = exportWindow && exportWindow.enabled && roiNum(exportWindow.rate) > 0 ? {
    hours: roiParseHours(`${exportWindow.from || '17:00'}-${exportWindow.to || '21:00'}`),
    rate: roiNum(exportWindow.rate),
    maxKwh: roiNum(exportWindow.max_kwh) || batteryKwh,
  } : null;
  const gc = batteryKwh > 0 && gridCharge && gridCharge.enabled ? {
    hours: roiParseHours(`${gridCharge.from || '00:00'}-${gridCharge.to || '06:00'}`),
    rate: roiNum(gridCharge.rate),
    maxKwh: roiNum(gridCharge.max_kwh) || Infinity,
  } : null;
  let spareFill = 0, spareFullDays = 0, dayWeight = 0;
  const totals = { generation: 0, selfUse: 0, charged: 0, discharged: 0, batteryExport: 0, exported: 0, curtailed: 0, imported: 0, importBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, costBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, dischargedBy: { flat: 0, peak: 0, shoulder: 0, off_peak: 0, solar_soak: 0 }, load: 0, gridCharged: 0, gridChargeCost: 0 };
  S.seasons.forEach((season, si) => S.dayTypes.forEach(dayType => ROI_DAY_KINDS.forEach((dayKind, dk) => {
    const days = 365 / S.seasons.length * dayType.share * dayKind.share;
    // the day from 6am, before the battery
    const day = [];
    for (let i = 0; i < 24; i++) {
      const h = (6 + i) % 24;
      const load = dailyGeneral * loadShape[h] * season.load;
      const gen = solarKw * S.yieldPerKw * season.gen * dayType.gen * solarShape[h];
      day.push({ h, load, gen, band: plan.bandOf(h, si, dk), rate: plan.rateOf(h, si, dk) || 0 });
    }
    // how much of the battery the spare solar of this day could fill
    if (batteryKwh > 0) {
      const spare = day.reduce((a, d) => a + Math.max(0, d.gen - d.load), 0) * eff;
      spareFill += Math.min(1, spare / batteryKwh) * days;
      if (spare >= batteryKwh * 0.95) spareFullDays += days;
      dayWeight += days;
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
    // one pass over the day; `count` is the days it stands for (0 while the battery is settling)
    const runDay = (count) => {
      let exportLeft = exp ? exp.maxKwh : 0;
      let gridLeft = gc ? gc.maxKwh : 0;
      for (let i = 0; i < 24; i++) {
        const d = day[i];
        if (d.h === 0) exportLeft = exp ? exp.maxKwh : 0;
        const self = Math.min(d.gen, d.load);
        let surplus = d.gen - self;
        let deficit = d.load - self;
        let out = 0; // what the battery sells to the grid this hour
        totals.generation += d.gen * count;
        totals.selfUse += self * count;
        totals.load += d.load * count;
        if (batteryKwh > 0) {
          const charge = Math.min(surplus, Math.max(0, batteryKwh - soc) / eff, cRate);
          soc += charge * eff;
          surplus -= charge;
          totals.charged += charge * count;
          let gridIn = 0;
          if (gc && gc.hours.has(d.h) && gridLeft > 0) {
            const price = gc.rate != null ? gc.rate : d.rate;
            // enough for what it will replace at a higher price, after losses, before the panels refill it
            const need = dearerAhead(i, price / S.batteryRoundTrip);
            const store = Math.max(0, Math.min(batteryKwh, need / eff) - soc);
            gridIn = Math.max(0, Math.min(store / eff, cRate - charge, gridLeft));
            soc += gridIn * eff;
            gridLeft -= gridIn;
            totals.gridCharged += gridIn * count;
            totals.gridChargeCost += gridIn * count * price / 100;
          }
          if (exp && exp.hours.has(d.h) && exportLeft > 0 && exp.rate > d.rate) {
            const e = Math.max(0, Math.min(soc * eff - dearerAhead(i, exp.rate), exportLeft, cRate, cap == null ? Infinity : cap));
            soc -= e / eff;
            exportLeft -= e;
            out += e;
            totals.batteryExport += e * count;
          }
          const discharge = gridIn > 0 ? 0 : Math.max(0, Math.min(deficit, soc * eff - dearerAhead(i, d.rate), cRate - out));
          soc -= discharge / eff;
          deficit -= discharge;
          totals.discharged += discharge * count;
          totals.dischargedBy[d.band] += discharge * count;
        }
        // what the export limit lets out this hour, after what the battery is selling; the rest is lost
        const sent = cap == null ? surplus : Math.min(surplus, Math.max(0, cap - out));
        totals.exported += sent * count;
        totals.curtailed += (surplus - sent) * count;
        totals.imported += deficit * count;
        totals.importBy[d.band] += deficit * count;
        totals.costBy[d.band] += deficit * count * d.rate / 100;
      }
    };
    // settle: the same day again and again until the battery starts it with what it ended the last
    // with. A day that never settles (the charge swings between two states) is counted as two days
    // in a row, half the days each, so neither state is picked by chance.
    let settled = batteryKwh <= 0;
    for (let warm = 0; warm < 24 && !settled; warm++) { const start = soc; runDay(0); settled = Math.abs(soc - start) < 0.01; }
    if (settled) runDay(days);
    else { runDay(days / 2); runDay(days / 2); }
  })));
  const controlledKwh = (metrics.controlledDailyKwh || 0) * 365;
  const usageCost = Object.values(totals.costBy).reduce((s, v) => s + v, 0);
  const controlledCost = controlledKwh * (plan.controlled || 0) / 100;
  const supplyCost = plan.supply * 365 / 100;
  const feedInCredit = totals.exported * plan.feed_in / 100;
  const batteryExportCredit = exp ? totals.batteryExport * exp.rate / 100 : 0;
  // the plan's own terms, when the bill gave them (the current plan only, roiBillAdjust): a
  // percentage off usage, a percentage off the bill, and fixed credits or charges a year
  const adj = plan.adjust || { percentOfUse: 0, percentOfBill: 0, annualFixed: 0 };
  const bill = ((usageCost + controlledCost + totals.gridChargeCost) * (1 - adj.percentOfUse) + supplyCost) * (1 - adj.percentOfBill) - feedInCredit - batteryExportCredit + adj.annualFixed;
  const round = (v) => Math.round(v);
  return {
    solarKw, batteryKwh,
    generation: round(totals.generation), selfUse: round(totals.selfUse), charged: round(totals.charged), discharged: round(totals.discharged),
    batteryExport: round(totals.batteryExport), exported: round(totals.exported), curtailed: round(totals.curtailed), imported: round(totals.imported), controlledKwh: round(controlledKwh),
    importBy: Object.fromEntries(Object.entries(totals.importBy).map(([k, v]) => [k, round(v)])),
    costBy: Object.fromEntries(Object.entries(totals.costBy).map(([k, v]) => [k, round(v)])),
    dischargedBy: Object.fromEntries(Object.entries(totals.dischargedBy).map(([k, v]) => [k, round(v)])),
    usageCost: round(usageCost), controlledCost: round(controlledCost), supplyCost: round(supplyCost), feedInCredit: round(feedInCredit), batteryExportCredit: round(batteryExportCredit),
    bill: round(bill), exportRate: exp ? exp.rate : null,
    gridCharged: round(totals.gridCharged), gridChargeCost: round(totals.gridChargeCost), gridChargeRate: gc ? gc.rate : null, gridCharging: !!gc,
    // the share of the battery the spare solar fills on an average day, and the share of days it fills it all
    spareFill: dayWeight ? Math.round(spareFill / dayWeight * 100) / 100 : null, spareFullDays: dayWeight ? Math.round(spareFullDays / dayWeight * 100) / 100 : null,
  };
}

// Discounts, credits and other charges read off the bill (read-electricity-bill.js), as the terms
// the current plan is costed with: a percentage off usage, a percentage off the whole bill, and
// fixed credits less other charges scaled from the bill's days to a year. Out of range reads as none.
function roiBillAdjust(reading, metrics) {
  const r = reading || {};
  const pct = (v) => { const n = roiNum(v); return n != null && n > 0 && n <= 60 ? n / 100 : 0; };
  const fixed = metrics.days ? (Math.abs(roiNum(r.other_charges_total) || 0) - Math.abs(roiNum(r.fixed_credits_total) || 0)) * 365 / metrics.days : 0;
  return { percentOfUse: pct(r.usage_discount_percent), percentOfBill: pct(r.bill_discount_percent), annualFixed: Math.round(fixed) };
}

// The home every figure runs on, worked out once (the estimate and the plan comparison share it):
// the settings in use, the bill's figures, the current plan, when the home uses power, the export
// limit, any existing solar and whether it stays, and the home's own use. A bill from a home with
// solar only shows what was bought, so the home's use (and, on a time-of-use bill, its use in each
// band) is raised until the model, with that solar on the roof, buys what the bill says. A yearly
// use typed for the quote is used as it is.
function roiHome({ reading, answers, inputs, zoneRating, siteAddress, siteSun, template }) {
  const inp = inputs || {};
  const S = roiSettings(inp, zoneRating, siteAddress, siteSun);
  const metrics = billMetrics(reading);
  if (!metrics.dailyKwh) return null;
  const existingKw = existingSolarKw(answers);
  const existingRemoved = existingKw > 0 && roiExistingRemoved(answers, template);
  const current = roiPlan(inp.current, reading, (reading && reading.retailer) ? `${reading.retailer} (current plan)` : 'Current plan');
  current.adjust = roiBillAdjust(reading, metrics);
  const solarShape = roiSolarShape();
  const exportLimitKw = roiExportLimitKw(answers);
  let fit = roiLoadShape(metrics, current, S);
  let dailyKwh = metrics.dailyKwh;
  // false when the day was fitted to the bill's bands but, with the existing solar on the roof, the
  // model does not end up buying the bill's split (the page then says "our closest fit")
  let matched = true;
  if (S.annualKwh) { dailyKwh = S.annualKwh / 365; matched = !(existingKw > 0); }
  else if (existingKw > 0) {
    // what the home uses in each band, starting from what it bought in each (the bill's split)
    const sp = metrics.split;
    const bands = fit.fitted ? { peak: sp.peak, shoulder: sp.shoulder, offPeak: sp.offPeak, solarSoak: sp.solarSoak || 0 } : null;
    const billBand = bands ? { peak: sp.peak, shoulder: sp.shoulder, off_peak: sp.offPeak, solar_soak: sp.solarSoak || 0 } : null;
    const billTotal = bands ? Object.values(billBand).reduce((t, v) => t + v, 0) : 0;
    const key = { peak: 'peak', shoulder: 'shoulder', off_peak: 'offPeak', solar_soak: 'solarSoak' };
    const floor = metrics.controlledDailyKwh || 0;
    const buy = () => roiRunStage({ metrics, plan: current, loadShape: fit.shape, solarShape, solarKw: existingKw, batteryKwh: 0, settings: S, dailyKwh, exportLimitKw });
    const gapOf = (st) => metrics.dailyKwh - (st.imported + st.controlledKwh) / 365;
    // how far the share bought in any band is from the bill's; with move, each band's use is nudged toward it
    const bandsOffOf = (st, move) => {
      let off = 0;
      if (!bands || !(st.imported > 0)) return off;
      Object.keys(billBand).forEach(b => {
        const want = billBand[b] / billTotal, got = (st.importBy[b] || 0) / st.imported;
        if (!(want > 0) || !(got > 0)) return;
        off = Math.max(off, Math.abs(want - got));
        if (move) bands[key[b]] *= Math.min(2, Math.max(0.5, want / got));
      });
      return off;
    };
    let settled = false;
    for (let i = 0; i < 12 && !settled; i++) {
      const st = buy(), gap = gapOf(st), off = bandsOffOf(st, true);
      if (bands) { const refit = roiLoadShape(metrics, current, S, bands); if (refit.fitted) fit = refit; }
      settled = Math.abs(gap) < 0.02 && off < 0.01;
      if (!settled) dailyKwh = Math.max(floor, dailyKwh + gap);
    }
    if (!settled) {
      // a midday band can leave the bands chasing each other: hold the shape, bring the total back
      // to what the bill bought, and call it matched only when the bands ended close
      let st = buy();
      for (let i = 0; i < 8 && Math.abs(gapOf(st)) >= 0.02; i++) { dailyKwh = Math.max(floor, dailyKwh + gapOf(st)); st = buy(); }
      matched = bandsOffOf(st, false) < 0.03;
    }
  }
  const usesBill = !S.annualKwh && !(existingKw > 0); // the home's use is just what the bill says it bought
  const useKwh = usesBill ? metrics.annualKwh : Math.round(dailyKwh * 365);
  return {
    settings: S, metrics, current, loadShape: fit.shape, solarShape, exportLimitKw,
    existingKw, existingRemoved, afterExistingKw: existingRemoved ? 0 : existingKw,
    dailyKwh, useKwh, boughtKwh: metrics.annualKwh,
    ownSolarKwh: existingKw > 0 && !S.annualKwh ? Math.max(0, useKwh - metrics.annualKwh) : 0, // what the existing solar supplies direct
    useTyped: !!S.annualKwh,
    daylightShare: roiDaylightShare(fit.shape),
    shapeFrom: fit.fitted ? (matched ? 'bill' : 'near') : (S.daylightShare != null ? 'typed' : 'assumed'),
  };
}

// The whole estimate: three stages on the current plan, and on the second plan when set.
// Every dollar figure is at today's prices. The long-run figures let the panels make a little less
// each year and count the battery's share for the years it is counted for (settings.batteryLifeYears);
// the "Rise" figures are the same with prices rising every year (settings.priceRise). A payback is
// the year the savings so far, at today's prices, reach the price.
function roiEstimate(argsIn) {
  const { reading, answers, inputs, newSolarKw, batteryKwh, zoneRating, siteAddress, siteSun, netCost, solarPrice, batteryPrice, billGst, template } = roiIncGstArgs(argsIn);
  const home = roiHome({ reading, answers, inputs, zoneRating, siteAddress, siteSun, template });
  if (!home) return null;
  const { settings: S, metrics } = home;
  const inp = inputs || {};
  const solar = roiNum(newSolarKw) || 0;
  const battery = roiNum(batteryKwh) || 0;
  const plans = [home.current];
  if (inp.alt && inp.alt.enabled) plans.push(roiPlan(inp.alt, reading, inp.alt.name || 'Other plan'));
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
  // the solar on the roof once the job is done: the new system, plus the existing one when it stays
  const kwAfter = home.afterExistingKw + solar;
  // when the home uses power is worked out once, from the bill's kWh split and the current plan's
  // times; a second plan is priced on that same pattern (its own times must not reshape the home)
  const scenarios = plans.map((plan, idx) => {
    const run = (kw, kwh, grid) => roiRunStage({ metrics, plan, loadShape: home.loadShape, solarShape: home.solarShape, solarKw: kw, batteryKwh: kwh, settings: S, dailyKwh: home.dailyKwh, exportLimitKw: home.exportLimitKw, exportWindow: kwh > 0 ? inp.export : null, gridCharge: kwh > 0 && grid ? inp.grid_charge : null });
    const base = run(home.existingKw, 0);
    const withSolar = (solar > 0 || home.existingRemoved) ? run(kwAfter, 0) : base;
    const full = battery > 0 ? run(kwAfter, battery, true) : withSolar;
    const fullSolarOnly = battery > 0 && inp.grid_charge && inp.grid_charge.enabled ? run(kwAfter, battery, false) : null;
    // not floored at zero: a smaller system replacing a bigger one makes the bill rise, and the
    // solar's and the battery's shares must still add up to the total
    const solarSaving = base.bill - withSolar.bill;
    const batterySaving = withSolar.bill - full.bill;
    const totalSaving = base.bill - full.bill;
    // a year's saving y years on: the panels' loss each year, and past the battery's counted years
    // only the solar's share is left. rise is the yearly price rise (0 for today's prices).
    const fade = (y, rise) => Math.pow(1 + rise, y) * Math.pow(1 - S.panelLoss, y);
    const inYear = (y, rise) => (battery > 0 && y >= S.batteryLifeYears ? Math.min(solarSaving, totalSaving) : totalSaving) * fade(y, rise);
    const over = (years, rise) => { let sum = 0; for (let y = 0; y < years; y++) sum += inYear(y, rise); return Math.round(sum); };
    const series = (rise) => { const out = []; for (let y = 0; y <= 25; y++) out.push(over(y, rise)); return out; };
    // years until the savings so far reach the price (by a straight line inside the year); null when
    // there is no price or the savings never get there. Capped for the page: over the cap is null too,
    // shown as "Not paid off in 25 years" (paybackRaw keeps the uncapped figure for the staff checks).
    const yearsTo = (price, yearly) => {
      if (!(price > 0)) return null;
      let sum = 0;
      for (let y = 0; y < 80; y++) {
        const add = yearly(y);
        if (add > 0 && sum + add >= price) return Math.round((y + (price - sum) / add) * 10) / 10;
        sum += add;
      }
      return null;
    };
    const capped = (y) => (y != null && y <= ROI_ASSUMPTIONS.paybackCapYears ? y : null);
    const paybackRaw = yearsTo(prices.total, (y) => inYear(y, 0));
    const batteryPaybackRaw = yearsTo(prices.battery, (y) => (y < S.batteryLifeYears ? batterySaving * fade(y, 0) : 0));
    // the words for a payback: the years, or why not. A battery whose saving stops being counted
    // before it has paid for itself says so, not "25 years".
    const lifeText = `Not paid off in the ${S.batteryLifeYears} years the battery's saving is counted for`;
    const words = (years, batteryLimited) => (years != null ? `${years} years` : batteryLimited ? lifeText : ROI_NOT_PAID_OFF);
    const totalLimited = battery > 0 && paybackRaw == null && totalSaving > 0 && S.batteryLifeYears < ROI_ASSUMPTIONS.paybackCapYears;
    // "now" is the real bill when this is the current plan and the bill has a total; the model's
    // figure otherwise. The after figures move with the saving so the two always agree.
    const actualNow = idx === 0 && metrics.annualBill ? metrics.annualBill : null;
    const billNow = actualNow != null ? actualNow : base.bill;
    return {
      key: idx === 0 ? 'current' : 'alt', name: plan.name, plan,
      stages: { base, solar: withSolar, full, fullSolarOnly },
      gridChargeAdds: fullSolarOnly ? Math.round(fullSolarOnly.bill - full.bill) : null,
      billNow, billNowIsActual: actualNow != null, modelledNow: base.bill,
      billWithSolar: Math.round(billNow - solarSaving), billAfter: Math.round(billNow - totalSaving),
      solarSaving: Math.round(solarSaving), batterySaving: Math.round(batterySaving), totalSaving: Math.round(totalSaving),
      solarPayback: capped(yearsTo(prices.solar, (y) => solarSaving * fade(y, 0))),
      batteryPayback: capped(batteryPaybackRaw), batteryPaybackText: words(capped(batteryPaybackRaw), batteryPaybackRaw == null && batterySaving > 0),
      payback: capped(paybackRaw), paybackRaw, paybackText: words(capped(paybackRaw), totalLimited),
      returnPercent: prices.total > 0 && totalSaving > 0 ? Math.round(totalSaving / prices.total * 1000) / 10 : null,
      saving10: over(10, 0), saving25: over(25, 0), cumulative: series(0),
      saving10Rise: over(10, S.priceRise), saving25Rise: over(25, S.priceRise), cumulativeRise: series(S.priceRise),
      // generation that is used or sold in place of grid power (what the export limit throws away is not)
      co2TonnesPerYear: Math.max(0, Math.round(((full.generation - full.curtailed) - (base.generation - base.curtailed)) * S.emissions / 1000 * 10) / 10),
    };
  });
  return { home, settings: S, metrics, existingKw: home.existingKw, existingRemoved: home.existingRemoved, exportLimitKw: home.exportLimitKw, newSolarKw: solar, batteryKwh: battery, yieldPerKw: S.yieldPerKw, prices, scenarios, current: scenarios[0], alt: scenarios[1] || null, exportWindow: inp.export && inp.export.enabled ? inp.export : null, gridCharge: battery > 0 && inp.grid_charge && inp.grid_charge.enabled ? inp.grid_charge : null, billGst };
}

// "Not paid off in 25 years": the one wording for a payback past the cap wherever it is shown (F32).
const ROI_NOT_PAID_OFF = `Not paid off in ${ROI_ASSUMPTIONS.paybackCapYears} years`;

// ---------- other retail plans (docs/IDEAS_BACKLOG.md item 34) ----------

// Prices a list of published plans on this home's use: the yearly bill as the home is now and with
// the quoted system, each on the same usage pattern (from the bill and the current plan's times).
// candidates: [{ key, roi_plan, adjust: { percent_of_use, percent_of_bill, annual_fees } }].
// Night charging, when ticked, uses each plan's own rate at that time; a VPP export window is the
// current plan's own deal and is not carried over. Returns null without a usable bill.
function roiComparePlans(argsIn) {
  // the bill and the current plan on an inc GST basis, the same as every published plan (M10)
  const { reading, answers, inputs, newSolarKw, batteryKwh, zoneRating, siteAddress, siteSun, candidates, template } = roiIncGstArgs(argsIn);
  const home = roiHome({ reading, answers, inputs, zoneRating, siteAddress, siteSun, template });
  if (!home) return null;
  const { settings: S, metrics } = home;
  const inp = inputs || {};
  const solar = roiNum(newSolarKw) || 0;
  const battery = roiNum(batteryKwh) || 0;
  const kwAfter = home.afterExistingKw + solar;
  const changes = solar > 0 || battery > 0 || home.existingRemoved;
  const grid = inp.grid_charge && inp.grid_charge.enabled ? { ...inp.grid_charge, rate: null } : null;
  const stage = (plan, kw, kwh, extra) => roiRunStage({ metrics, plan, loadShape: home.loadShape, solarShape: home.solarShape, solarKw: kw, batteryKwh: kwh, settings: S, dailyKwh: home.dailyKwh, exportLimitKw: home.exportLimitKw, exportWindow: null, gridCharge: kwh > 0 ? grid : null, ...(extra || {}) });
  const cost = (plan, adjust) => {
    const a = adjust || {};
    const bill = (st) => Math.round(((st.usageCost + st.controlledCost + st.gridChargeCost) * (1 - (a.percent_of_use || 0)) + st.supplyCost) * (1 - (a.percent_of_bill || 0)) - st.feedInCredit + (a.annual_fees || 0));
    const now = stage(plan, home.existingKw, 0);
    const after = changes ? stage(plan, kwAfter, battery) : now;
    return { billNow: bill(now), billAfter: bill(after), exported: after.exported, feedIn: plan.feed_in };
  };
  // The current plan is costed exactly as on the savings page: its own battery deals (selling to the
  // grid, the typed night rate), and, when the bill has a total, moved by the amount the real bill
  // sits above or below these rates, so the two pages show the one "with the system" figure. Every
  // other plan is moved by that same amount, so the rows are all on the one footing and the
  // difference between two rows is the difference between the plans.
  const nowStage = stage(home.current, home.existingKw, 0);
  const afterStage = changes ? stage(home.current, kwAfter, battery, { exportWindow: battery > 0 ? inp.export : null, gridCharge: battery > 0 ? inp.grid_charge : null }) : nowStage;
  const offset = metrics.annualBill ? metrics.annualBill - nowStage.bill : 0;
  const currentCost = { billNow: Math.round(nowStage.bill + offset), billAfter: Math.round(afterStage.bill + offset), exported: afterStage.exported, feedIn: home.current.feed_in, modelledNow: nowStage.bill };
  const rows = (candidates || []).map(c => {
    const plan = roiPlan(c.roi_plan, null, c.key);
    const r = cost(plan, c.adjust);
    const moved = offset + home.current.adjust.annualFixed; // the bill's own credits and charges (a rebate, a concession) follow the customer
    const billNow = Math.round(r.billNow + moved), billAfter = Math.round(r.billAfter + moved);
    return { key: c.key, plan, ...r, billNow, billAfter, vsCurrentAfter: billAfter - currentCost.billAfter, vsCurrentNow: billNow - currentCost.billNow };
  });
  rows.sort((x, y) => x.billAfter - y.billAfter);
  return { current: { plan: home.current, ...currentCost }, rows, withSystem: changes };
}

// What the customer is told wherever plan options are shown: a suggestion to help their own research,
// not a recommendation (owner's words, 23 Oct 2026).
const ROI_PLAN_DISCLAIMER = 'These are other electricity plans published for your area, shown only as a suggestion to help you research your options. Thomson Energy does not endorse any retailer, cannot connect you with a retailer or switch your plan for you, and receives no payment or commission from any retailer. The rates are an online estimate taken from each retailer\'s published plan on Energy Made Easy (the government\'s comparison site) on the date shown, and we cannot promise them. Check the current rates, eligibility and conditions with the retailer before you decide.';

// Plans whose price follows the wholesale market change price every 5 minutes: we do not estimate
// them (owner, 23 Oct 2026). A proper estimate is backlogged (docs/IDEAS_BACKLOG.md item 35).
const ROI_WHOLESALE_NOTE = 'We don\'t do estimates for wholesale rates: plans whose price follows the wholesale electricity market (such as Amber, Localvolts, Flow Power and Powerclub) change price every 5 minutes, so they are not estimated or shown here.';
const ROI_WHOLESALE_REASON = 'Price follows the wholesale market, which the estimate cannot cost.';

// ---------- what is missing ----------

// What is missing for an honest savings estimate. A `blocking` gap keeps the figures that rest on
// it off the proposal: the page asks the customer for what it needs (the `client` text) instead of
// showing a number built on a default. Gaps with no client text are the staff's to fix. The rest
// are warnings only: the figures show, with the assumption declared.
function roiGaps(argsIn) {
  const { reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, billGst, billGstTyped, overridden } = roiIncGstArgs(argsIn);
  const gaps = [];
  const a = answers || {};
  const r = reading || null;
  const m = billMetrics(r);
  const hasBattery = template === 'battery' || (template === 'solar' && a.with_battery === 'Yes');
  const plan = roiPlan((inputs || {}).current, r, 'Current plan');
  // key, whether it holds figures back, what to ask the customer for (null: the staff's to fix), and
  // any detail the staff wording needs (roiGapStaffText in solar-roi-staff.js)
  const add = (key, blocking, client, info) => gaps.push({ key, blocking, client: client || null, info: info || {} });
  const noBill = !r || r.estimated; // estimated: figures typed in place of a bill (roiApplyOverrides)
  // a block the quote shows anyway stays listed (a typed use or rate fills its gap, so it is asked for by key)
  const shown = new Set(overridden || []);
  if (noBill) add('bill', true, 'a recent electricity bill, every page, so we can see how much power you use and what you pay for it');
  if (r && !noBill) {
    if (!m.dailyKwh || shown.has('usage')) add('usage', true, 'the page of your bill with the usage table (kWh used and the number of days in the period)');
    if (!plan.hasRate || shown.has('rate')) add('rate', true, 'the page of your bill that shows your rates (cents per kWh, and the daily supply charge)');
    if (roiNum(r.bill_total) == null) add('total', true, 'the page of your bill with the total amount for the period');
    if (m.days && m.days < 28) add('short', false, 'a full quarterly bill if you have one (the one we have covers only a short period)', { days: m.days });
    if (!m.split) add('tou', false);
  }
  if (r) {
    if ((m.hasSolarAlready || template === 'battery') && (!existingSolarKw(a) || shown.has('existing'))) add('existing', true, 'the size of your existing solar system in kW (on the inverter label or your original paperwork)', { battery: template === 'battery' });
    if (!plan.supplyKnown) add('supply', false);
    if (!plan.feedInKnown && (roiNum(newSolarKw) > 0 || m.hasSolarAlready)) add('feedin', false);
    if (billGst === 'ex') add('gst', false, null, { typed: billGstTyped });
  }
  if (template !== 'battery' && !(roiNum(newSolarKw) > 0)) add('size', true);
  if (hasBattery && !(roiNum(batteryKwh) > 0)) add('battery', false);
  if (!(roiNum(netCost) > 0)) add('price', true);
  else if (roiNum(newSolarKw) > 0 && roiNum(batteryKwh) > 0 && roiNum(solarPrice) == null && roiNum(batteryPrice) == null) add('split_prices', false);
  // a block shown anyway holds nothing back; the staff wording is added where the staff file is
  // loaded (the quote page), not on the proposal
  return gaps.map(g => ({ ...g, ...(shown.has(g.key) ? { blocking: false, overridden: true } : {}), staff: typeof roiGapStaffText === 'function' ? roiGapStaffText(g) : '' }));
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
// Dollars as the estimate shows them: whole dollars, and to the nearest $10 where the page says
// "about" (an estimate to the cent claims more than it knows).
const roiDollars = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-AU')}`;
const roiAbout = (n) => roiDollars(Math.round(n / 10) * 10);
// a yearly bill, which can be in credit, and a yearly saving, which can be a cost
const roiBillText = (n) => (n < 0 ? `in credit by ${roiDollars(-n)} a year` : `${roiDollars(n)} a year`);
const roiSavingText = (n) => (n < 0 ? `costs ${roiDollars(-n)} a year more` : `${roiDollars(n)} a year`);
const roiPct = (share) => `${Math.round(share * 1000) / 10}%`;
const roiEsc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// How far the yearly saving moves when the two biggest guesses move: the sun (7% less with one more
// overcast day in ten, or 5% more with one fewer) and when the home uses power (a tenth more of the
// day's use in daylight, or a tenth less). { low, high } in dollars, rounded out to the nearest $50.
function roiSavingRange(estArgs, est) {
  const S = est.settings;
  const day = S.daylightShare != null ? S.daylightShare : roiDaylightShare(roiLoadShape({ split: null }, { tariff: 'flat' }, null).shape);
  const tryWith = (over) => { const e = roiEstimate({ ...estArgs, inputs: { ...(estArgs.inputs || {}), assumptions: { ...S.typed, ...over } } }); return e ? e.current.totalSaving : null; };
  const values = [
    est.current.totalSaving,
    tryWith({ yield_per_kw: S.yieldPerKw * 0.93, clear_day_share: Math.max(0.3, S.clearShare - 0.1) }),
    tryWith({ yield_per_kw: S.yieldPerKw * 1.05, clear_day_share: Math.min(1, S.clearShare + 0.1) }),
    tryWith({ daylight_share: Math.min(0.9, day + 0.1) }),
    tryWith({ daylight_share: Math.max(0.1, day - 0.1) }),
  ].filter(v => v != null);
  return { low: Math.max(0, Math.floor(Math.min(...values) / 50) * 50), high: Math.ceil(Math.max(...values) / 50) * 50 };
}

const ROI_WHAT_CHANGES = 'These figures change if your power use changes (an electric car, a pool, working from home), if you move to a different electricity plan, or if the panels are shaded.';

// What the figures rest on, in two lists for the customer: what came off their bill, and what we
// assumed, each with its value. Every assumption the maths makes that moves the answer is here.
function roiBasisLists({ est, reading, gaps, dollars, bills, money, overridden, overrideNotes }) {
  const home = est.home, S = est.settings, m = est.metrics, cur = est.current, plan = cur.plan;
  const r = reading || {};
  const typedIn = new Set(overridden || []); // figures typed in place of the bill's (roiApplyOverrides): not "from your bill"
  const fromBill = [], assumed = [...(overrideNotes || [])];
  const days = m.days ? `${m.days} days` : '';
  if (!r.estimated) fromBill.push(['Your bill', [r.retailer ? String(r.retailer) : '', days, bills && m.billTotal != null ? (m.billTotal < 0 ? `${money(-m.billTotal)} in credit` : money(m.billTotal)) : ''].filter(Boolean).join(', ') || 'as read']);
  if (!r.estimated && !typedIn.has('usage')) fromBill.push(['Power you bought', `${m.totalKwh ? `${roiKwh(m.totalKwh)}, ` : ''}${m.dailyKwh} kWh a day`]);
  const adj = plan.adjust || {};
  const terms = [adj.percentOfUse ? `${roiPct(adj.percentOfUse)} off your usage` : '', adj.percentOfBill ? `${roiPct(adj.percentOfBill)} off the bill` : '', adj.annualFixed < 0 ? `credits of about ${roiDollars(-adj.annualFixed)} a year` : '', adj.annualFixed > 0 ? `other charges of about ${roiDollars(adj.annualFixed)} a year` : ''].filter(Boolean);
  if (terms.length) fromBill.push(['Discounts, credits and charges', `${terms.join(', ')}. Kept the same with the system`]);
  if (dollars && !r.estimated && !typedIn.has('rate')) {
    const rates = plan.tariff === 'tou' ? ROI_BANDS.filter(b => (plan.bandShare[b.key] || 0) > 0 && plan.rateKnown[b.key]).map(b => `${b.label.toLowerCase()} ${plan[b.key]}`).join(', ') : `${plan.rate}`;
    if (rates) fromBill.push(['What you pay', `${rates} c/kWh`]);
  }
  const ours = r.estimated ? ', our estimate' : '';
  if (plan.supplyKnown) (ours ? assumed : fromBill).push(['Daily supply charge', `${plan.supply} c a day${ours}`]);
  if (plan.feedInKnown) (ours ? assumed : fromBill).push(['Solar feed-in', `${plan.feed_in} c/kWh${ours}`]);
  if (m.hasSolarAlready) fromBill.push(['Solar you sent to the grid', roiKwh(m.exportKwh)]);
  if (plan.tariff === 'tou' && plan.timesFrom !== 'assumed') fromBill.push(['When each rate applies', roiScheduleText(plan)]);
  if (home.shapeFrom === 'bill') fromBill.push(['When you use power', 'Matched to the peak, shoulder and off-peak kWh on your bill']);

  if (home.shapeFrom !== 'bill') assumed.push(['When you use power', `${home.shapeFrom === 'near' ? 'Our closest fit to the peak, shoulder and off-peak kWh on your bill, allowing for your existing solar:' : `We do not have meter readings for your home, so we used ${home.shapeFrom === 'typed' ? 'a day with' : 'a typical household day:'}`} about ${Math.round(home.daylightShare * 100)}% of your power between 6am and 6pm`]);
  if (home.useTyped) assumed.push(['Your year', `${roiKwh(home.useKwh)} a year, our estimate of your yearly use`]);
  else if (!r.estimated && !typedIn.has('usage')) assumed.push(['Your year', `The ${days || 'period'} on your bill ${days ? 'stand' : 'stands'} for your whole year`]);
  if (est.newSolarKw > 0 || home.existingKw > 0) {
    // two lines, so the day spread never reads as sun taken off a second time
    const fromRecords = S.sunRecords && S.typed.yield_per_kw == null ? `, from the sun records for your area (${S.sunRecords})` : '';
    assumed.push(['Sun', `${S.yieldPerKw} kWh a day from each kW of panels${fromRecords}. That is the average over the whole year, with cloudy days and normal losses already counted`]);
    const clear = Math.round(S.clearShare * 10);
    assumed.push(['Clear and dull days', clear >= 10 ? 'Every day is taken as an average day' : `The year's sun is spread as ${clear} clear days in 10 and ${10 - clear} overcast${S.typed.overcast_output != null || S.sunRecords ? ` (an overcast day making ${Math.round(S.overcastGen * 100)}% of a normal day's power)` : ''}. That does not change the yearly total: it allows for dull days, when the panels cover less of the home${est.batteryKwh > 0 ? ' and the battery does not fill' : ''}`]);
  }
  if (Object.keys(S.typed).some(k => /^season_/.test(k))) assumed.push(['Seasons', `Against the yearly average, summer, autumn, winter and spring: panels make ${S.seasons.map(sn => `${Math.round(sn.gen * 100)}%`).join(', ')}; the home uses ${S.seasons.map(sn => `${Math.round(sn.load * 100)}%`).join(', ')}`]);
  if (home.existingKw > 0) assumed.push(['Your existing solar', `${home.existingKw} kW${typedIn.has('existing') ? ' (our estimate: we do not have its size)' : ''}${home.ownSolarKwh > 0 ? `, supplying about ${roiKwh(home.ownSolarKwh)} a year that your bill does not show` : ''}. ${home.existingRemoved ? 'It comes off the roof with this job' : 'It stays and keeps working'}`]);
  if (est.newSolarKw > 0 || home.existingKw > 0) assumed.push(['Export limit', home.exportLimitKw == null ? 'None applied: all spare solar is taken as sold to the grid' : home.exportLimitKw === 0 ? 'Nothing is sent to the grid' : `No more than ${home.exportLimitKw} kW goes to the grid at any time`]);
  if (est.batteryKwh > 0) assumed.push(['Battery', `Gives back ${Math.round(S.batteryRoundTrip * 100)}% of the power put into it${S.typed.battery_charge_rate != null ? `, charging or discharging up to ${Math.round(S.batteryMaxChargeC * 100)}% of its size in an hour` : ''}. Its saving is counted for ${S.batteryLifeYears} years`]);
  if (dollars) {
    assumed.push(['Prices', `Today's prices in every figure${S.priceRise > 0 && cur.totalSaving > 0 ? `. If power prices rise ${roiPct(S.priceRise)} a year, the saving is about ${roiAbout(cur.saving10Rise)} over 10 years and ${roiAbout(cur.saving25Rise)} over 25` : ''}`]);
    if (est.newSolarKw > 0) assumed.push(['Panels', `Make ${roiPct(S.panelLoss)} less power each year`]);
    if (S.typed.grid_emissions != null) assumed.push(['Grid emissions', `${S.emissions} kg of CO2 for each kWh from the grid`]);
    const gone = r.estimated ? '' : 'Not on your bill: ';
    if (!plan.supplyKnown) assumed.push(['Daily supply charge', `${gone}${plan.supply} c a day assumed`]);
    if (!plan.feedInKnown && (est.newSolarKw > 0 || home.existingKw > 0)) assumed.push(['Solar feed-in', `${gone}${plan.feed_in} c/kWh assumed`]);
    if (plan.tariff === 'tou') {
      const guessed = ROI_BANDS.filter(b => (plan.bandShare[b.key] || 0) > 0 && !plan.rateKnown[b.key]);
      if (guessed.length) assumed.push(['Rates not on your bill', `${guessed.map(b => `${b.label.toLowerCase()} ${plan[b.key]} c/kWh`).join(', ')} assumed`]);
    }
    if (plan.tariff === 'tou' && plan.timesFrom === 'assumed') assumed.push(['When each rate applies', `Not on your bill: ${roiScheduleText(plan)} assumed`]);
    if (est.billGst === 'ex') assumed.push(['GST', 'Your bill is before GST; its figures are shown here with GST added, to compare with the price']);
    const diff = cur.billNowIsActual ? cur.billNow - cur.modelledNow : 0;
    if (bills && Math.abs(diff) > Math.max(50, cur.billNow * 0.03)) assumed.push(['Your bill total', `About ${roiAbout(Math.abs(diff))} a year ${diff < 0 ? 'less than your rates and use add up to (a discount or a credit we could not see on the bill)' : 'more than your rates and use add up to (other charges on the bill)'}. We kept that difference the same with the system`]);
  }
  return { fromBill, assumed };
}

// ---------- presentation ----------

// Everything the proposal (and the quote page preview) shows: the headline figures and their likely
// range, the two lists of what the figures rest on, the sections and rows of the working (one value
// per plan), the asks ("to give you Y, we need X") for what the customer can supply, and the
// staff-side gaps and checks. Nothing is withheld that we do have; nothing is shown that rests on a
// missing figure: no rates means kWh rows only, no bill total means no "bills now and after", no
// existing solar size when the bill shows export means use only.
function roiPresentation(argsIn) {
  // clientType ('company' | 'individual') and inputs.bill_gst set the GST basis of the bill (M10); the
  // bill and the inputs are normalised to inc GST once here and passed on normalised
  const args = roiIncGstArgs(argsIn);
  const { reading, answers, template, newSolarKw, batteryKwh, netCost, zoneRating, siteAddress, siteSun, money, inputs, solarPrice, batteryPrice, linesBatteryKwh, pylonStorage, billGst, billGstTyped, clientType, overridden, overrideNotes } = args;
  const gaps = roiGaps({ reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, billGst, billGstTyped, clientType, overridden });
  const has = (k) => !gaps.some(g => g.key === k && !g.overridden);
  const asks = gaps.filter(g => g.client).map(g => ({ key: g.key, need: g.client, gives: (!g.overridden && ROI_GAP_GIVES[g.key]) || 'a more accurate estimate', blocking: g.blocking }));
  const m = billMetrics(reading);
  const checkArgs = { reading, answers, template, newSolarKw, batteryKwh, netCost, inputs, solarPrice, batteryPrice, linesBatteryKwh, pylonStorage, money, billGst, billGstTyped, clientType };
  // the mistake checks are staff only: they run where solar-roi-staff.js is loaded (the quote page), not on the proposal
  const staffChecks = (est) => (typeof roiChecks === 'function' ? roiChecks({ ...checkArgs, est }) : []);
  const empty = { gaps, asks, sections: [], columns: [], est: null, metrics: m, dollars: false, rows: [], checks: staffChecks(null), headline: null, range: null, fromBill: [], assumed: [], whatChanges: '' };
  if (!reading || !m.dailyKwh) return empty;
  const canModel = has('existing') && ((roiNum(newSolarKw) || 0) > 0 || (roiNum(batteryKwh) || 0) > 0);
  if (!canModel) {
    const sections = [{ title: 'Your home now', rows: [['Power bought', [`${roiKwh(m.annualKwh)} a year (${m.dailyKwh} kWh a day)`]]] }];
    if (has('total') && m.annualBill) sections[0].rows.push(['Bills now', [roiBillText(m.annualBill)]]);
    return { ...empty, sections, columns: ['Estimate'], rows: sections[0].rows.map(([k, v]) => [k, v[0]]), assumed: overrideNotes || [] };
  }
  const estArgs = { reading, answers, template, inputs, newSolarKw, batteryKwh, zoneRating, siteAddress, siteSun, netCost, solarPrice, batteryPrice, billGst, billGstTyped, clientType };
  const est = roiEstimate(estArgs);
  const home = est.home, S = est.settings;
  const dollars = has('rate');
  const bills = dollars && has('total');
  const cols = est.scenarios.map(s => s.name);
  const per = (fn) => est.scenarios.map(fn);
  const saves = (fn) => per(s => (s.totalSaving > 0 ? fn(s) : '-'));
  const lost = (stage) => (est.scenarios.some(s => s.stages[stage].curtailed > 0)
    ? [['Lost to the export limit', per(s => `${roiKwh(s.stages[stage].curtailed)} a year (no more than ${est.exportLimitKw} kW can go to the grid)`)]] : []);
  const sections = [];
  sections.push({ title: 'Your home now', rows: [
    ['Power used', per(() => `${roiKwh(home.useKwh)} a year (${Math.round(home.useKwh / 365 * 10) / 10} kWh a day)`)],
    ...(home.existingKw > 0 && home.ownSolarKwh > 0 ? [['Of that', per(() => `${roiKwh(home.boughtKwh)} bought, about ${roiKwh(home.ownSolarKwh)} from your existing solar`)]] : []),
    ...(bills ? [['Bills now', per(s => `${roiBillText(s.billNow)}${s.billNowIsActual ? ' (from your bill)' : ' (at these rates)'}`)]] : []),
  ] });
  if (est.newSolarKw > 0) {
    sections.push({ title: `Step 1: ${est.newSolarKw} kW of solar${est.existingKw ? (est.existingRemoved ? ` (replacing your ${est.existingKw} kW)` : ` (on top of your ${est.existingKw} kW)`) : ''}`, rows: [
      ['Solar generated', per(s => `${roiKwh(s.stages.solar.generation - (est.existingRemoved ? 0 : s.stages.base.generation))} a year`)],
      ['Used straight away', per(s => `${roiKwh(s.stages.solar.selfUse)} a year`)],
      ['Sent to the grid', per(s => `${roiKwh(s.stages.solar.exported)} a year at ${s.plan.feed_in} c/kWh`)],
      ...lost('solar'),
      ['Still bought from the grid', per(s => `${roiKwh(s.stages.solar.imported)} a year`)],
      ...(dollars ? [
        ['Saving from the solar', per(s => roiSavingText(s.solarSaving))],
        ...(est.prices.solar != null && est.prices.solar > 0 && est.batteryKwh > 0 ? [['Solar pays for itself in', per(s => s.solarPayback ? `${s.solarPayback} years (${money(est.prices.solar)})` : ROI_NOT_PAID_OFF)]] : []),
      ] : []),
    ] });
  }
  if (est.batteryKwh > 0) {
    sections.push({ title: `Step ${est.newSolarKw > 0 ? 2 : 1}: adding the ${est.batteryKwh} kWh battery`, rows: [
      ['Filled by spare solar', per(s => s.stages.full.spareFill == null ? '-' : `about ${Math.round(s.stages.full.spareFill * 100)}% of the battery on an average day`)],
      ['Stored instead of exported', per(s => `${roiKwh(s.stages.full.charged)} a year`)],
      ...(est.gridCharge ? [['Charged from the grid at night', per(s => `${roiKwh(s.stages.full.gridCharged)} a year at ${s.stages.full.gridChargeRate != null ? `${s.stages.full.gridChargeRate} c/kWh` : 'the plan\'s rate then'} (${roiDollars(s.stages.full.gridChargeCost)})`)]] : []),
      ['Used later from the battery', per(s => `${roiKwh(s.stages.full.discharged)} a year`)],
      ...(est.exportWindow ? [['Sold from the battery', per(s => `${roiKwh(s.stages.full.batteryExport)} a year at ${s.stages.full.exportRate} c/kWh (${est.exportWindow.from || '17:00'} to ${est.exportWindow.to || '21:00'})`)]] : []),
      ...lost('full'),
      ['Still bought from the grid', per(s => `${roiKwh(s.stages.full.imported)} a year`)],
      ...(dollars ? [
        ['Extra saving from the battery', per(s => roiSavingText(s.batterySaving))],
        ...(est.prices.battery != null && est.prices.battery > 0 && est.newSolarKw > 0 ? [['Battery pays for itself in', per(s => s.batteryPayback ? `${s.batteryPayback} years (${money(est.prices.battery)})` : s.batteryPaybackText)]] : []),
      ] : []),
    ] });
  }
  if (dollars) {
    const counted = est.batteryKwh > 0 && S.batteryLifeYears < 25 ? ` (the battery's share counted for ${S.batteryLifeYears} years)` : '';
    sections.push({ title: 'Together', rows: [
      ...(bills ? [['Bills after', per(s => roiBillText(s.billAfter))]] : []),
      ['Total saving', per(s => roiSavingText(s.totalSaving))],
      ...(est.prices.total > 0 ? [
        ['Your investment', per(() => `${money(est.prices.total)} after the credits`)],
        ['Pays for itself in', per(s => s.paybackText)],
        ['Yearly return', per(s => s.returnPercent != null ? `${s.returnPercent}% of the investment` : '-')],
      ] : []),
      // no long-run savings rows where the bill goes up (a plan column that does save still shows its own)
      ...(est.scenarios.some(s => s.totalSaving > 0) ? [
        ['Saving over 10 years', saves(s => roiDollars(s.saving10))],
        ['Saving over 25 years', saves(s => `${roiDollars(s.saving25)}${counted}`)],
        ...(S.priceRise > 0 ? [[`If power prices rise ${roiPct(S.priceRise)} a year`, saves(s => `${roiDollars(s.saving10Rise)} over 10 years, ${roiDollars(s.saving25Rise)} over 25`)]] : []),
      ] : []),
      ['Emissions avoided', per(s => `about ${s.co2TonnesPerYear} tonnes of CO2 a year`)],
    ] });
  }
  const rows = sections.flatMap(sec => sec.rows.map(([k, v]) => [k, v[0]]));
  const cur = est.current;
  // the figures the page opens with (the current plan): null where we cannot stand behind one
  const headline = dollars ? {
    billNow: bills ? cur.billNow : null, billNowIsActual: cur.billNowIsActual, rateTyped: (overridden || []).includes('rate'), billAfter: bills ? cur.billAfter : null, saving: cur.totalSaving,
    payback: est.prices.total > 0 ? cur.payback : null, paybackText: cur.paybackText, hasPrice: est.prices.total > 0,
    alt: est.alt ? { name: est.alt.name, saving: est.alt.totalSaving } : null,
  } : null;
  const range = dollars && cur.totalSaving > 0 ? roiSavingRange(estArgs, est) : null;
  const lists = roiBasisLists({ est, reading, gaps, dollars, bills, money, overridden, overrideNotes });
  return { gaps, asks, sections, columns: cols, est, metrics: m, dollars, bills, rows, checks: staffChecks(est), headline, range, fromBill: lists.fromBill, assumed: lists.assumed, whatChanges: ROI_WHAT_CHANGES };
}

// The top of the savings page, the same on the proposal and in the quote page's preview: the bill
// now, the bill with the system and the saving, then how soon it pays for itself and the likely range.
function roiHeadlineHtml(pres) {
  const h = pres.headline;
  if (!h) return '';
  const tile = (label, value, sub, strong) => `<div style="flex:1 1 150px; padding:14px 16px; border:1px solid ${strong ? '#1a6be6' : '#d9dde5'};${strong ? ' background:#f1f5fd;' : ''}"><div style="font-size:11.5px; letter-spacing:0.05em; text-transform:uppercase; color:#5b6472;">${roiEsc(label)}</div><div style="font-family:Archivo, Helvetica, Arial, sans-serif; font-weight:600; font-size:27px; line-height:1.15; margin-top:4px; color:#0a0a0a;">${roiEsc(value)}</div><div style="font-size:12px; color:#5b6472; margin-top:2px;">${roiEsc(sub)}</div></div>`;
  const tiles = [];
  const bill = (n) => (n < 0 ? `about ${roiAbout(-n)} in credit` : `about ${roiAbout(n)}`);
  if (h.billNow != null) tiles.push(tile('Your power bill now', bill(h.billNow), h.billNowIsActual ? 'a year, from your bill' : h.rateTyped ? 'a year, our estimate' : 'a year, at your rates'));
  if (h.billAfter != null) tiles.push(tile('With this system', bill(h.billAfter), 'a year'));
  tiles.push(h.saving < 0 ? tile('Your bill goes up by', `about ${roiAbout(-h.saving)}`, 'a year', true) : tile('You save', `about ${roiAbout(h.saving)}`, 'a year', true));
  const lines = [];
  if (h.hasPrice && h.saving > 0) lines.push(h.payback ? `The system pays for itself in about <strong>${roiEsc(h.payback)} years</strong>.` : `<strong>${roiEsc(h.paybackText)}</strong>.`);
  if (pres.range && pres.range.high > pres.range.low) lines.push(`These are estimates, not a promise: your saving is likely to be between <strong>${roiDollars(pres.range.low)} and ${roiDollars(pres.range.high)} a year</strong>, depending on the weather and when you use your power.`);
  if (h.alt) lines.push(`On ${roiEsc(h.alt.name)} the same system would ${h.alt.saving < 0 ? `cost about ${roiAbout(-h.alt.saving)} a year more` : `save about ${roiAbout(h.alt.saving)} a year`}.`);
  return `<div class="roi-headline"><div style="display:flex; flex-wrap:wrap; gap:10px;">${tiles.join('')}</div>${lines.length ? `<p style="margin:12px 0 0; font-size:14px; line-height:1.6; color:#0a0a0a;">${lines.join(' ')}</p>` : ''}</div>`;
}

// The two lists under the pictures: what came off the bill, then what we assumed, then what would
// change the figures. Plain words, one line each. Each list is a heading and a block of lines (class
// "rows"), so the proposal can carry a long list over onto the next sheet a line at a time.
function roiListsHtml(pres) {
  if (!pres.fromBill.length && !pres.assumed.length) return '';
  const list = (title, items) => (items.length ? `<div class="sec-title roi-list-title" style="font-family:Archivo, Helvetica, Arial, sans-serif; font-weight:500; font-size:12.5px; text-transform:uppercase; letter-spacing:0.04em; color:#1a6be6; margin:16px 0 2px;">${roiEsc(title)}</div><div class="rows roi-list">${items.map(([k, v]) => `<div style="padding:6px 0; border-bottom:1px solid #d9dde5; font-size:12.5px; line-height:1.5; color:#0a0a0a;"><strong>${roiEsc(k)}:</strong> ${roiEsc(v)}</div>`).join('')}</div>` : '');
  return `${list('From your bill', pres.fromBill)}${list('What we assumed', pres.assumed)}${pres.whatChanges ? `<p class="note-line roi-changes" style="margin:10px 0 0; font-size:12px; line-height:1.55; color:#5b6472;">${roiEsc(pres.whatChanges)}</p>` : ''}`;
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
    bars.forEach(b => { b.text = b.v < 0 ? `${roiDollars(-b.v)} cr` : roiDollars(b.v); }); // "cr": a bill in credit, short enough to sit over its bar
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
  const use = Math.max(est.home.useKwh, 1);
  const parts = [
    { label: 'Straight from the solar', kwh: full.selfUse, color: c.solar },
    { label: 'From the battery', kwh: full.discharged, color: c.battery },
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

  if (dollars && est.prices.total > 0 && s.cumulative && s.totalSaving > 0) {
    // the savings so far at today's prices (solid) against the price; the dashed line is the same with
    // power prices rising every year
    const cum = s.cumulative, rise = est.settings.priceRise > 0 ? s.cumulativeRise : null;
    const maxV = Math.max(cum[25], rise ? rise[25] : 0, est.prices.total, 1);
    const X = (y) => 36 + Math.round(y * 170 / 25);
    const Y = (v) => 130 - Math.round(110 * v / maxV);
    const line = (arr) => arr.map((v, y) => `${y === 0 ? 'M' : 'L'}${X(y)},${Y(v)}`).join(' ');
    const pb = s.payback && s.payback <= ROI_ASSUMPTIONS.paybackCapYears ? s.payback : null;
    // the payback and the investment sit under the plot, so no label can collide with the line
    charts.push(`
      <figure class="roi-fig">
        <figcaption>Savings add up</figcaption>
        <svg viewBox="0 0 220 ${rise ? 200 : 186}" width="100%" role="img" aria-label="At today's prices savings reach ${esc(roiDollars(cum[10]))} after 10 years and ${esc(roiDollars(cum[25]))} after 25 years against an investment of ${esc(money(est.prices.total))}${pb ? `, paid off after about ${esc(pb)} years` : ''}">
          <line x1="36" y1="130" x2="206" y2="130" stroke="${c.line}" stroke-width="1" />
          <line x1="36" y1="${Y(est.prices.total)}" x2="206" y2="${Y(est.prices.total)}" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" />
          ${rise ? `<path d="${line(rise)}" fill="none" stroke="${c.solar}" stroke-width="1.5" stroke-dasharray="2 3" opacity="0.7" />` : ''}
          <path d="${line(cum)}" fill="none" stroke="${c.solar}" stroke-width="2" stroke-linejoin="round" />
          ${pb ? `<circle cx="${X(pb)}" cy="${Y(est.prices.total)}" r="5" fill="${c.solar}" stroke="#fff" stroke-width="2" />` : ''}
          <circle cx="${X(25)}" cy="${Y(cum[25])}" r="4" fill="${c.solar}" stroke="#fff" stroke-width="2" />
          <text x="${X(25)}" y="${Y(cum[25]) - 8}" text-anchor="end" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${esc(roiDollars(cum[25]))}</text>
          <text x="36" y="146" font-size="10.5" fill="${c.muted}" style="${font}">Today</text>
          <text x="${X(10)}" y="146" text-anchor="middle" font-size="10.5" fill="${c.muted}" style="${font}">10 years</text>
          <text x="206" y="146" text-anchor="end" font-size="10.5" fill="${c.muted}" style="${font}">25 years</text>
          <text x="10" y="166" font-size="11" font-weight="600" fill="${c.ink}" style="${font}">${pb ? `Paid off after about ${esc(pb)} years` : esc(s.paybackText.length > 34 ? ROI_NOT_PAID_OFF : s.paybackText)}</text>
          <g transform="translate(10, 179)"><line x1="0" y1="-4" x2="14" y2="-4" stroke="${c.grid}" stroke-width="1.5" stroke-dasharray="4 3" /><text x="20" y="0" font-size="10.5" fill="${c.muted}" style="${font}">Investment ${esc(money(est.prices.total))}</text></g>
          ${rise ? `<g transform="translate(10, 193)"><line x1="0" y1="-4" x2="14" y2="-4" stroke="${c.solar}" stroke-width="1.5" stroke-dasharray="2 3" opacity="0.7" /><text x="20" y="0" font-size="10.5" fill="${c.muted}" style="${font}">If prices rise ${esc(roiPct(est.settings.priceRise))} a year</text></g>` : ''}
        </svg>
      </figure>`);
  }
  return `<div class="roi-charts">${charts.join('')}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROI_ASSUMPTIONS, ROI_BANDS, ROI_BAND_LABEL, ROI_PLAN_DISCLAIMER, ROI_WHOLESALE_NOTE, ROI_WHOLESALE_REASON, ROI_NOT_PAID_OFF, roiComparePlans, billMetrics, existingSolarKw, roiNum, roiBillGst, roiIncGstArgs, roiPlan, roiParseHours, roiParseMonths, roiBillWindows, roiCleanWindows, roiScheduleText, roiDayPatterns, roiBatteryKwhFromLines, roiSettings, roiSiteYield, roiApplyOverrides, roiExportLimitKw, roiExportLimitUnclear, roiExistingRemoved, roiExistingRemovedFromWords, ROI_EXISTING_STAYS, ROI_EXISTING_GOES, roiHome, roiEstimate, roiGaps, roiPresentation, roiChartsHtml, roiHeadlineHtml, roiListsHtml, roiDollars, roiAbout };
}
