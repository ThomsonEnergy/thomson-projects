// Long-run sun records for a place (backlog item 75): ten years of daily sun from NASA's POWER
// service (free, no key, the whole world on a grid of about 100 km), boiled down to what the
// savings estimate needs for a site: the yearly sun figure, how the seasons differ, and how many
// days are dull and how little they make. Used by site-sun.js. Each grid cell is fetched once and
// kept in the sun_climate table (the only thing written here).
//
// Nothing here is guessed for a site. The one thing the records cannot say is how much a kW of
// panels makes from a given amount of sun (roof pitch, heat, wiring and inverter losses), so that
// is taken from the Clean Energy Council's published figures for Sydney (3.9 kWh per kW a day) and
// Brisbane (4.2) against the same records for those two cities (so those two still come out at
// their published figures) and every other site moves with its own sun. The seasons are handled
// the same way: the estimate's normal season spread is taken as right for Sydney and shifted by
// how the site's seasons differ from Sydney's in the records.
//
// The records are an average over a cell about 100 km across, not one roof, and an area has far
// fewer dull days than a single roof does. The first live run (12 Nov 2026, the Northern Rivers
// cell) counted 1 dull day in 10 where the estimate assumes 3, which would have lifted every
// battery quote's saving. So the dull day figures (clear_share, overcast_output) are still worked
// out and kept with the rest, for the record, but the estimate does not use them: it keeps its own
// clear and dull days (solar-roi.js roiSiteSun). The yearly figure and the seasons are used.

const fetch = require('node-fetch');
const { ROI_ASSUMPTIONS } = require('../../../public/js/solar-roi.js');

const POWER_URL = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const YEARS = 10;
const KEEP_DAYS = 400;            // a cell's records are fetched again after this long
const DULL_BELOW = 0.6;           // a day under 60% of its month's average counts as dull
const REFERENCE = [
  { name: 'Sydney', lat: -33.87, lng: 151.21, yield: 3.9 },
  { name: 'Brisbane', lat: -27.47, lng: 153.03, yield: 4.2 },
];
const SEASON_OF_MONTH = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0]; // Jan..Dec: summer, autumn, winter, spring

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// The cell a place falls in, named by its centre. The sun records are one degree cells with their
// edges on whole degrees, so every place in a cell reads the same figures and one fetch serves
// them all (and no exact address ever goes to the service).
function sunCell(lat, lng) {
  const centre = (v) => (Math.floor(v) + 0.5).toFixed(1);
  return `${centre(lat)},${centre(lng)}`;
}

// POWER's daily answer as [{ date: 'YYYYMMDD', kwh }], in kWh per square metre a day. The unit is
// read from the answer itself (the service gives MJ for some communities); missing days (its
// fill value, a negative number, or anything that is not a number) are left out. Throws when the
// answer is not the expected shape, when more than a tenth of the `wanted` days are missing, or
// when the figures are not believable for sun, so a change at their end is never read as data.
function parsePower(json, wanted = YEARS * 365) {
  const series = json && json.properties && json.properties.parameter && json.properties.parameter.ALLSKY_SFC_SW_DWN;
  if (!series || typeof series !== 'object') throw new Error('The sun records came back in a shape this code does not know.');
  const unit = String((((json.parameters || {}).ALLSKY_SFC_SW_DWN || {}).units) || '').toLowerCase();
  const perKwh = /mj/.test(unit) ? 3.6 : (/wh/.test(unit) && !/kw/.test(unit) ? 1000 : 1);
  const days = Object.keys(series).filter(d => /^\d{8}$/.test(d) && typeof series[d] === 'number' && series[d] >= 0).map(d => ({ date: d, kwh: series[d] / perKwh }));
  if (days.length < wanted * 0.9) throw new Error(`The sun records came back with too few days (${days.length} of about ${wanted}).`);
  const mean = days.reduce((t, d) => t + d.kwh, 0) / days.length;
  if (!(mean > 2 && mean < 8)) throw new Error(`The sun records do not look like sun (an average of ${round(mean, 2)} a day).`);
  return days;
}

async function fetchDailySun(lat, lng) {
  const lastYear = new Date().getUTCFullYear() - 1;
  const query = new URLSearchParams({ parameters: 'ALLSKY_SFC_SW_DWN', community: 'RE', latitude: String(lat), longitude: String(lng), start: `${lastYear - YEARS + 1}0101`, end: `${lastYear}1231`, format: 'JSON' });
  const res = await fetch(`${POWER_URL}?${query}`, { timeout: 20000 });
  if (!res.ok) throw new Error(`The sun records could not be fetched (${res.status}).`);
  return { days: parsePower(await res.json()), years: `${lastYear - YEARS + 1} to ${lastYear}` };
}

// Ten years of days as the figures the estimate uses:
//   psh        average sun, kWh per square metre a day
//   seasons    [summer, autumn, winter, spring] sun against the yearly average
//   dullShare  share of days under DULL_BELOW of their own month's average
//   dullOutput what those dull days get, against an average day of their month
function summariseSun(days) {
  const monthOf = (d) => Number(d.date.slice(4, 6)) - 1;
  const mean = (list) => list.reduce((t, v) => t + v, 0) / (list.length || 1);
  const psh = mean(days.map(d => d.kwh));
  const byMonth = Array.from({ length: 12 }, () => []);
  days.forEach(d => byMonth[monthOf(d)].push(d.kwh));
  const monthMean = byMonth.map(mean);
  const seasonDays = [[], [], [], []];
  days.forEach(d => seasonDays[SEASON_OF_MONTH[monthOf(d)]].push(d.kwh));
  const ratios = days.map(d => (monthMean[monthOf(d)] > 0 ? d.kwh / monthMean[monthOf(d)] : 1));
  const dull = ratios.filter(r => r < DULL_BELOW);
  return {
    psh: round(psh, 3),
    seasons: seasonDays.map(list => round(mean(list) / psh, 3)),
    dullShare: round(dull.length / ratios.length, 3),
    dullOutput: round(dull.length ? mean(dull) : DULL_BELOW, 3),
    days: days.length,
  };
}

// A cell's summary, from the table when it is there and fresh, else fetched and kept. When the
// fetch fails and an older row is kept, the older row stands: ten year averages a year old are
// still right for the area.
async function getClimate(admin, lat, lng) {
  const cell = sunCell(lat, lng);
  const { data: kept } = await admin.from('sun_climate').select('cell, summary, years, fetched_at').eq('cell', cell).maybeSingle();
  const have = kept ? { cell, years: kept.years, ...kept.summary } : null;
  if (have && Date.now() - new Date(kept.fetched_at).getTime() < KEEP_DAYS * 86400000) return have;
  try {
    const [cLat, cLng] = cell.split(',').map(Number);
    const { days, years } = await fetchDailySun(cLat, cLng);
    const summary = summariseSun(days);
    const { error } = await admin.from('sun_climate').upsert({ cell, lat: cLat, lng: cLng, years, summary, fetched_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return { cell, years, ...summary };
  } catch (err) {
    if (!have) throw err;
    console.error(`sun-climate: keeping the older records for ${cell}:`, err.message);
    return have;
  }
}

// A site's sun, ready for the estimate, from its own summary and the two reference cities'.
// Pure: the tests call it with made-up summaries.
function siteSunFrom(site, sydney, brisbane) {
  // kWh from a kW of panels for each unit of sun: what each published city figure implies. A site
  // with Sydney's sun or less takes Sydney's, with Brisbane's or more takes Brisbane's, and one in
  // between slides from one to the other (the average of the two if the cities ever read alike).
  const perS = REFERENCE[0].yield / sydney.psh, perB = REFERENCE[1].yield / brisbane.psh;
  const span = brisbane.psh - sydney.psh;
  const perSun = Math.abs(span) < 0.2 ? (perS + perB) / 2 : perS + (perB - perS) * Math.min(1, Math.max(0, (site.psh - sydney.psh) / span));
  // the estimate's normal season spread, shifted by how this site's seasons differ from Sydney's, kept averaging 1
  const shifted = ROI_ASSUMPTIONS.seasons.map((sn, i) => sn.gen * site.seasons[i] / sydney.seasons[i]);
  const avg = shifted.reduce((t, v) => t + v, 0) / 4;
  return {
    yield_per_kw: round(site.psh * perSun, 2),
    seasons: shifted.map(v => round(v / avg, 3)),
    clear_share: round(1 - site.dullShare, 2),
    overcast_output: round(site.dullOutput, 2),
    psh: round(site.psh, 2),
    years: site.years,
    cell: site.cell,
    source: 'NASA POWER daily sun records',
  };
}

// The whole thing for a place. Three cells at most are fetched the first time (the site and the
// two reference cities, each once even when the site is in a city's cell); after that everything
// comes from the table.
async function siteSunFor(admin, lat, lng) {
  const asked = new Map();
  const climate = (la, ln) => { const cell = sunCell(la, ln); if (!asked.has(cell)) asked.set(cell, getClimate(admin, la, ln)); return asked.get(cell); };
  const [site, sydney, brisbane] = await Promise.all([climate(lat, lng), climate(REFERENCE[0].lat, REFERENCE[0].lng), climate(REFERENCE[1].lat, REFERENCE[1].lng)]);
  return siteSunFrom(site, sydney, brisbane);
}

module.exports = { siteSunFor, siteSunFrom, summariseSun, parsePower, sunCell };
