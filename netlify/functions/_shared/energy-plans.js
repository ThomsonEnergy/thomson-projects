// Retail electricity plans from the AER's Consumer Data Right product reference data (the data behind
// Energy Made Easy), for the plan suggestions on a quote (docs/IDEAS_BACKLOG.md item 34).
//
//   discoverBrands()        every energy retailer brand and where its plans are published
//   listPlans(brand)        a brand's current electricity market plans (summary)
//   fetchPlanDetail(...)    one plan in full (rates, times, feed-in, discounts, fees, eligibility)
//   convertPlan(detail)     that plan in the savings estimate's terms (public/js/solar-roi.js roiPlan):
//                           rates in c/kWh inc GST, supply in c/day inc GST, feed-in in c/kWh, time windows
//
// Plans are public data. Prices in the CDR feed are dollars excluding GST (feed-in has no GST).
// Nothing here is a recommendation: the quote page and the proposal say so.

const fetch = require('node-fetch');
const { roiParseHours } = require('../../../public/js/solar-roi.js');

// Bump when convertPlan changes, so the next download converts every stored plan again.
const CONVERTER_VERSION = 2;
// Retailers whose price follows the wholesale market: their published rate is only indicative, so
// their plans are kept but never costed.
const WHOLESALE_BRANDS = /^(amber|localvolts|flow-power|powerclub)$/i;

const REGISTER_URL = 'https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary';
const AER_BASE = 'https://cdr.energymadeeasy.gov.au';
// If the register cannot be read, these AER brand paths are tried instead (most NSW and QLD retailers).
const FALLBACK_BRANDS = ['agl', 'origin', 'energyaustralia', 'red-energy', 'alinta', 'momentum', 'powershop', 'simply-energy', 'lumo', 'dodo',
  'globird', 'tango', 'nectr', 'ovo-energy', 'amber', 'covau', 'sumo', '1st-energy', 'energy-locals', 'powerclub', 'kogan', 'enova', 'diamond-energy',
  'arcline', 'radian', 'reamped', 'blue-nrg', 'qenergy', 'actewagl', 'locality-planning', 'besy', 'cooperative-power', 'future-x', 'altogether',
  'engie', 'lumo-energy', 'sumo-power', 'shell-energy', 'mojo-power', 'origin-energy', 'agl-energy', 'localvolts', 'flow-power', 'energyaustralia-business'];

// The networks Thomson Energy quotes on: NSW and QLD only, where it is licensed (not the ACT, see
// docs/BUSINESS_FACTS.md). A plan is kept when it is sold on one of them.
const NETWORKS = [
  { key: 'Essential Energy', match: /essential/i },
  { key: 'Ausgrid', match: /ausgrid/i },
  { key: 'Endeavour Energy', match: /endeavour/i },
  { key: 'Energex', match: /energex/i },
  { key: 'Ergon Energy', match: /ergon/i },
];
function networkKey(name) {
  const n = NETWORKS.find(x => x.match.test(String(name || '')));
  return n ? n.key : null;
}

async function fetchJson(url, version, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'x-v': String(version), 'x-min-v': '1' }, timeout: timeoutMs });
      if (res.status === 406 || res.status === 404) return { status: res.status, json: null };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 800 * (t + 1)));
    }
  }
  throw lastErr;
}

// Every energy brand from the CDR register, with the base of its product data (the AER hosts it).
async function discoverBrands() {
  const out = [];
  let why = null;
  for (const version of [2, 1]) {
    out.length = 0;
    try {
      let url = REGISTER_URL;
      let rows = 0;
      for (let page = 0; url && page < 20; page++) {
        const { status, json } = await fetchJson(url, version);
        if (!json) { why = `register HTTP ${status} (x-v ${version})`; break; }
        const data = json.data || [];
        rows += data.length;
        data.forEach(b => {
          let base = b.productBaseUri || b.productReferenceDataBaseUri || null;
          if (base) base = String(base).replace(/\/+$/, '').replace(/\/cds-au\/v1$/, '');
          if (base) out.push({ id: base.split('/').pop(), name: b.brandName || base.split('/').pop(), base });
        });
        url = json.links && json.links.next;
      }
      if (out.length) return { brands: dedupe(out), source: `register x-v ${version}`, why: null };
      if (rows && !why) why = `register gave ${rows} brands but no product data address (x-v ${version}); fields: ${Object.keys(((await fetchJson(REGISTER_URL, version)).json || { data: [{}] }).data[0] || {}).join(', ')}`;
    } catch (err) {
      why = `register error (x-v ${version}): ${String(err.message || err).slice(0, 200)}`;
    }
  }
  return { brands: FALLBACK_BRANDS.map(id => ({ id, name: id, base: `${AER_BASE}/${id}` })), source: 'fallback', why };
}
function dedupe(brands) {
  const seen = new Set();
  return brands.filter(b => (seen.has(b.base) ? false : (seen.add(b.base), true)));
}

// A brand's current electricity market plans (summaries), all pages.
async function listPlans(brand) {
  const plans = [];
  let url = `${brand.base}/cds-au/v1/energy/plans?type=MARKET&fuelType=ELECTRICITY&effective=CURRENT&page-size=1000`;
  for (let page = 0; url && page < 50; page++) {
    const { status, json } = await fetchJson(url, 1);
    if (!json) { if (page === 0) throw new Error(`plan list HTTP ${status}`); break; }
    ((json.data && json.data.plans) || []).forEach(p => plans.push(p));
    url = json.links && json.links.next;
  }
  return plans;
}

// One plan in full: the newest detail version the brand serves.
async function fetchPlanDetail(brand, planId) {
  for (const v of [3, 2, 1]) {
    const { status, json } = await fetchJson(`${brand.base}/cds-au/v1/energy/plans/${encodeURIComponent(planId)}`, v);
    if (json && json.data) return { detail: json.data, version: v };
    if (status !== 406) break;
  }
  return { detail: null, version: null };
}

// ---------- turning a published plan into the savings estimate's terms ----------

const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const inc = (dollarsExGst) => round(dollarsExGst * 110, 3); // $ ex GST to c inc GST
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bandOf(type, name) {
  const t = String(type || '').toUpperCase();
  if (t === 'PEAK') return 'peak';
  if (t === 'OFF_PEAK') return 'off_peak';
  if (/^SHOULDER/.test(t)) return 'shoulder';
  if (/SOLAR|SPONGE|SOAK/.test(t)) return 'solar_soak';
  const n = String(name || '').toLowerCase();
  if (/soak|sponge|super off|free|solar/.test(n)) return 'solar_soak';
  if (/shoulder/.test(n)) return 'shoulder';
  if (/off.?peak|night/.test(n)) return 'off_peak';
  if (/peak/.test(n)) return 'peak';
  return null;
}

// "15:00", "1500" or "15:00:00+10:00" to the nearest hour; "23:59" is the end of the day (24).
function hourOf(t) {
  const m = String(t || '').match(/^(\d{1,2}):?(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h === 23 && min >= 59) return 24;
  return Math.min(24, Math.round(h + min / 60));
}

function daysOf(days) {
  const list = (Array.isArray(days) ? days : [days]).map(d => String(d || '').toUpperCase());
  if (list.includes('BUSINESS_DAYS')) return 'weekdays';
  if (list.includes('WEEKENDS')) return 'weekends';
  const wd = ['MON', 'TUE', 'WED', 'THU', 'FRI'].filter(d => list.includes(d)).length;
  const we = ['SAT', 'SUN'].filter(d => list.includes(d)).length;
  if (wd === 5 && we === 0) return 'weekdays';
  if (wd === 0 && we === 2) return 'weekends';
  return 'all';
}

// "11-01" to "03-31" as "Nov-Mar"; blank when the period is the whole year.
function monthsOf(start, end) {
  const s = String(start || '').match(/^(\d{1,2})-(\d{1,2})/), e = String(end || '').match(/^(\d{1,2})-(\d{1,2})/);
  if (!s || !e) return '';
  const a = parseInt(s[1], 10), b = parseInt(e[1], 10);
  if ((a === 1 && b === 12) || ((b % 12) + 1 === a && parseInt(e[2], 10) >= 28)) return '';
  return `${MONTHS[a - 1]}-${MONTHS[b - 1]}`;
}
function periodDays(start, end) {
  const s = String(start || '').match(/^(\d{1,2})-(\d{1,2})/), e = String(end || '').match(/^(\d{1,2})-(\d{1,2})/);
  if (!s || !e) return 365;
  const doy = (m, d) => new Date(Date.UTC(2025, m - 1, d)).getTime() / 86400000;
  let n = doy(+e[1], +e[2]) - doy(+s[1], +s[2]) + 1;
  if (n <= 0) n += 365;
  return n;
}

// A block of rates (maybe stepped by volume) as one c/kWh inc GST figure: the step a typical home
// spends most of its use in, so the dearest step for small volumes is not taken as the whole price.
function rateOf(rates, notes) {
  const list = (rates || []).map(r => ({ price: num(r.unitPrice), volume: num(r.volume) })).filter(r => r.price != null);
  if (!list.length) return null;
  if (list.length > 1) notes.push('Stepped usage rates: the rate after the first step is used.');
  return inc(list.length > 1 ? list[1].price : list[0].price);
}

function windowsFromTimeOfUse(timeOfUse, band, months, notes) {
  const out = [];
  (timeOfUse || []).forEach(t => {
    const from = hourOf(t.startTime), to = hourOf(t.endTime);
    if (from == null || to == null) return;
    if (/:(?!00)\d{2}/.test(String(t.startTime || '')) || /:(?!00|59)\d{2}/.test(String(t.endTime || ''))) notes.add('Times rounded to the hour.');
    const pad = (h) => String(h % 24).padStart(2, '0');
    out.push({ band, hours: `${pad(from)}:00-${to === 24 ? '24' : pad(to)}:00`, days: daysOf(t.days), months });
  });
  return out;
}

// The savings estimate's plan for one published plan, what could and could not be costed, and the
// discounts and fees applied in the costing.
function convertPlan(detail) {
  const notes = new Set();
  const wholesale = WHOLESALE_BRANDS.test(String(detail.brand || ''));
  const warn = [];
  const contract = detail.electricityContract || detail.electricity || {};
  const periods = contract.tariffPeriod || contract.tariffPeriods || [];
  let costable = true;
  const reasons = [];
  if (!periods.length) { costable = false; reasons.push('No usage rates published.'); }

  const bandSum = {}; // band -> { weighted price, weight }
  const addRate = (band, price, weight) => { if (price == null) return; bandSum[band] = bandSum[band] || { p: 0, w: 0 }; bandSum[band].p += price * weight; bandSum[band].w += weight; };
  const windows = [];
  let supply = 0, supplyWeight = 0, flatRate = null, flatWeight = 0, tou = false;
  const longest = periods.reduce((best, p) => (periodDays(p.startDate, p.endDate) > periodDays(best && best.startDate, best && best.endDate) ? p : best), periods[0]);
  periods.forEach(p => {
    const days = periodDays(p.startDate, p.endDate);
    const months = periods.length > 1 ? monthsOf(p.startDate, p.endDate) : '';
    const daily = num(p.dailySupplyCharges ?? p.dailySupplyCharge ?? (p.dailySupplyChargesBand && p.dailySupplyChargesBand[0] && p.dailySupplyChargesBand[0].unitPrice));
    if (daily != null) { supply += inc(daily) * days; supplyWeight += days; }
    const kind = p.rateBlockUType || (p.timeOfUseRates ? 'timeOfUseRates' : p.singleRate ? 'singleRate' : p.demandCharges ? 'demandCharges' : null);
    if (kind === 'demandCharges' || (Array.isArray(p.demandCharges) && p.demandCharges.length)) { costable = false; reasons.push('Has a demand charge, which the estimate cannot cost.'); }
    if (kind === 'singleRate' && p.singleRate) {
      const r = rateOf(p.singleRate.rates, warn);
      if (r != null) { flatRate = (flatRate || 0) + r * days; flatWeight += days; }
    } else if (kind === 'timeOfUseRates' && Array.isArray(p.timeOfUseRates)) {
      tou = true;
      p.timeOfUseRates.forEach(t => {
        const band = bandOf(t.type, t.displayName);
        if (!band) { warn.push(`Unknown time of use rate "${t.displayName || t.type}" left out.`); return; }
        const r = rateOf(t.rates, warn);
        const tw = windowsFromTimeOfUse(t.timeOfUse, band, months, notes);
        const hours = tw.reduce((a, w) => a + roiParseHours(w.hours).size * (w.days === 'all' ? 7 : w.days === 'weekdays' ? 5 : 2), 0);
        addRate(band, r, days * Math.max(1, hours));
        if (p === longest || periods.length === 1 || months) windows.push(...tw);
      });
    }
  });
  const plan = { tariff: tou ? 'tou' : 'flat' };
  if (tou) {
    Object.keys(bandSum).forEach(b => { plan[b] = round(bandSum[b].p / bandSum[b].w, 2); });
    plan.windows = windows;
    // the band at any hour not listed: off-peak when the plan has one and lists no times for it
    const withTimes = new Set(windows.map(w => w.band));
    plan.other = ['off_peak', 'shoulder', 'peak', 'solar_soak'].find(b => plan[b] != null && !withTimes.has(b)) || 'off_peak';
    if (plan.peak == null && plan.off_peak == null) { costable = false; reasons.push('Time of use rates could not be read.'); }
    if (plan.peak == null) plan.peak = plan.shoulder ?? plan.off_peak;
    if (plan.off_peak == null) plan.off_peak = plan.shoulder ?? plan.peak;
  } else {
    plan.rate = flatWeight ? round(flatRate / flatWeight, 2) : null;
    plan.windows = [];
    if (plan.rate == null && costable) { costable = false; reasons.push('Usage rate could not be read.'); }
  }
  plan.supply = supplyWeight ? round(supply / supplyWeight, 2) : null;
  if (plan.supply == null) { costable = false; reasons.push('Daily supply charge could not be read.'); }
  if (periods.length > 1) notes.add('Rates change through the year: averaged over the year.');

  // controlled load (off-peak hot water and the like)
  const cl = (contract.controlledLoad || [])[0];
  if (cl) {
    const block = cl.singleRate || (cl.timeOfUseRates && cl.timeOfUseRates[0]);
    plan.controlled = block ? rateOf(block.rates, warn) : null;
  }

  // solar feed-in: the retailer's rate (a government scheme rate is closed to new customers)
  const fits = (contract.solarFeedInTariff || []).filter(f => String(f.payerType || '').toUpperCase() !== 'GOVERNMENT');
  let feed = null;
  fits.forEach(f => {
    const blocks = [];
    if (f.singleTariff) blocks.push(f.singleTariff.rates || []);
    const tv = f.timeVaryingTariffs;
    (Array.isArray(tv) ? tv : tv ? [tv] : []).forEach(x => blocks.push(x.rates || []));
    blocks.forEach(rates => rates.forEach(r => { const v = num(r.unitPrice); if (v != null) feed = feed == null ? v : Math.min(feed, v); }));
    if (blocks.some(rs => rs.length > 1) || (Array.isArray(tv) && tv.length > 1)) notes.add('The feed-in varies by time or volume: the lowest rate is used.');
  });
  plan.feed_in = feed == null ? 0 : round(feed * 100, 2);
  if (feed == null) notes.add('No solar feed-in published on this plan.');

  // discounts: guaranteed ones are applied, conditional ones are listed
  const adjust = { percent_of_use: 0, percent_of_bill: 0, annual_fees: 0 };
  const conditional = [];
  (contract.discounts || []).forEach(d => {
    const type = String(d.type || '').toUpperCase();
    const method = d.methodUType;
    const rate = num((d[method] || {}).rate);
    const pct = rate == null ? null : (rate > 1 ? rate / 100 : rate);
    const text = d.displayName || d.description || 'Discount';
    if (type === 'GUARANTEED' && pct != null && (method === 'percentOfUse' || method === 'percentOfBill')) adjust[method === 'percentOfUse' ? 'percent_of_use' : 'percent_of_bill'] += pct;
    else conditional.push(`${text}${pct != null ? ` (${round(pct * 100, 1)}%)` : ''}${type === 'CONDITIONAL' ? ', conditional' : ''}`);
  });
  // fees: a membership or plan fee that recurs is added to the yearly cost; others are listed
  const otherFees = [];
  const perYear = { DAILY: 365, WEEKLY: 52, MONTHLY: 12, QUARTERLY: 4, BIANNUAL: 2, ANNUAL: 1, '1_YEAR': 1 };
  (contract.fees || []).forEach(f => {
    const type = String(f.type || '').toUpperCase();
    const amount = num(f.amount);
    const factor = perYear[String(f.term || '').toUpperCase()];
    if ((type === 'MEMBERSHIP' || type === 'PLAN') && amount != null && factor) adjust.annual_fees += round(amount * 1.1 * factor, 2);
    else if (type === 'MEMBERSHIP' || type === 'PLAN' || type === 'CONNECTION' || type === 'ESTABLISHMENT') otherFees.push(`${f.description || type.toLowerCase()}${amount != null ? ` $${round(amount * 1.1, 2)}` : ''}`);
  });
  const eligibility = (contract.eligibility || detail.eligibility || []).map(e => [e.information, e.description].filter(Boolean).join(': ') || String(e.type || '').toLowerCase()).filter(Boolean);
  const text = `${detail.displayName || ''} ${detail.description || ''}`;
  if (wholesale || /wholesale|spot price|market price/i.test(text) || String(detail.pricingModel || contract.pricingModel || '').toUpperCase() === 'QUOTA') { costable = false; reasons.push('Price follows the wholesale market, which the estimate cannot cost.'); }

  return {
    roi_plan: plan,
    adjust,
    costable,
    notes: {
      cannot_cost: reasons,
      conditions: [...conditional, ...otherFees],
      eligibility,
      fixed_price: contract.isFixed === true,
      variation: contract.variation || null,
      warnings: [...new Set(warn)],
      model: [...notes],
      converter: CONVERTER_VERSION,
    },
  };
}

module.exports = { CONVERTER_VERSION, NETWORKS, networkKey, discoverBrands, listPlans, fetchPlanDetail, convertPlan, AER_BASE };
