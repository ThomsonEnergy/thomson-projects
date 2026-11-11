// Checks the sun records maths behind the savings estimate (backlog item 75,
// netlify/functions/_shared/sun-climate.js) on made-up records, so it runs anywhere:
//
//   node scripts/site-sun-check.js
//
// With --live it also fetches the real records (NASA POWER, needs the internet) and prints the
// figures a quote would get, for Sydney, Brisbane and any places given as lat,lng:
//
//   node scripts/site-sun-check.js --live -28.26,153.50
//
// Nothing is written anywhere: the live run keeps the records in memory only.
const path = require('path');
const { siteSunFor, siteSunFrom, summariseSun, parsePower, sunCell } = require(path.join(__dirname, '..', 'netlify', 'functions', '_shared', 'sun-climate.js'));
const { roiSettings } = require(path.join(__dirname, '..', 'public', 'js', 'solar-roi.js'));

let failed = 0;
const say = (ok, what, detail) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`); };
const near = (a, b, by) => Math.abs(a - b) <= by;
const throws = (fn) => { try { fn(); return false; } catch (err) { return true; } };

// Ten made-up years: sun that swings with the season around `mean`, with `dull` of the days at
// `dullAt` of a normal day. The same every run (a fixed seed).
function madeUpYears({ mean, swing, dull, dullAt }) {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const series = {};
  for (let year = 2015; year <= 2024; year++) {
    for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
      const dayOfYear = (d - Date.UTC(year, 0, 1)) / 86400000;
      const season = 1 + swing * Math.cos((2 * Math.PI * (dayOfYear - 15)) / 365); // most in mid January
      const clearAt = (1 - dull * dullAt) / (1 - dull);                            // so the days average out
      series[d.toISOString().slice(0, 10).replace(/-/g, '')] = mean * season * (rand() < dull ? dullAt : clearAt);
    }
  }
  return series;
}
const answer = (series, units) => ({ properties: { parameter: { ALLSKY_SFC_SW_DWN: series } }, parameters: { ALLSKY_SFC_SW_DWN: { units } } });

// 1. Where a place is filed.
say(sunCell(-33.87, 151.21) === '-33.5,151.5' && sunCell(-28.26, 153.5) === '-28.5,153.5' && sunCell(-28.99, 153.01) === sunCell(-28.01, 153.99), 'cell: a place is filed under the one degree cell it sits in');

// 2. Reading the service's answer.
const series = madeUpYears({ mean: 4.6, swing: 0.3, dull: 0.2, dullAt: 0.35 });
const days = parsePower(answer(series, 'kW-hr/m^2/day'));
say(days.length === 3653, 'read: every day of ten years is read', `${days.length} days`);
const inMj = Object.fromEntries(Object.entries(series).map(([d, v]) => [d, v * 3.6]));
say(near(summariseSun(parsePower(answer(inMj, 'MJ/m^2/day'))).psh, summariseSun(days).psh, 0.001), 'read: an answer in MJ is turned into kWh');
const withGaps = { ...series, 20240101: -999, 20240102: -999 };
say(parsePower(answer(withGaps, 'kW-hr/m^2/day')).length === 3651, 'read: missing days are left out, not counted as dark');
say(parsePower(answer({ ...series, 20240103: null, 20240104: '' }, 'kW-hr/m^2/day')).length === 3651, 'read: a blank day is missing too, not a dark day');
say(throws(() => parsePower({ properties: {} })), 'read: an answer in another shape is refused');
say(throws(() => parsePower(answer(Object.fromEntries(Object.entries(series).slice(0, 366)), 'kW-hr/m^2/day'))), 'read: one year where ten were asked for is refused');
say(throws(() => parsePower(answer(Object.fromEntries(Object.entries(series).filter(([d]) => !/^....0[678]/.test(d))), 'kW-hr/m^2/day'))), 'read: ten years with the winters missing are refused');
say(throws(() => parsePower(answer(Object.fromEntries(Object.entries(series).map(([d, v]) => [d, v * 100])), 'kW-hr/m^2/day'))), 'read: figures that cannot be sun are refused');

// 3. Boiling ten years down.
const sum = summariseSun(days);
say(near(sum.psh, 4.6, 0.1), 'sum: the yearly sun figure is the average day', `${sum.psh}`);
say(near(sum.dullShare, 0.2, 0.02) && near(sum.dullOutput, 0.35, 0.05), 'sum: dull days are counted, and how little they make', `${sum.dullShare} of days at ${sum.dullOutput}`);
say(near(sum.seasons.reduce((t, v) => t + v, 0) / 4, 1, 0.01) && sum.seasons[0] > sum.seasons[1] && sum.seasons[1] > sum.seasons[2] && sum.seasons[3] > sum.seasons[2], 'sum: the seasons average to the year, summer most and winter least', sum.seasons.join(', '));

// 4. The figures a quote gets.
const sydney = { ...sum, psh: 4.6, years: '2015 to 2024', cell: '-33.5,151.5' };
const brisbane = { ...sum, psh: 5.2, seasons: [1.2, 1.0, 0.8, 1.0], years: '2015 to 2024', cell: '-27.5,153.5' };
const at = (psh, more) => siteSunFrom({ ...sydney, psh, ...more }, sydney, brisbane);
say(at(4.6).yield_per_kw === 3.9 && siteSunFrom(brisbane, sydney, brisbane).yield_per_kw === 4.2, 'quote: Sydney and Brisbane come out at their published 3.9 and 4.2');
say(at(4.9).yield_per_kw > 3.9 && at(4.9).yield_per_kw < 4.2, 'quote: a site with sun between the two lands between them', `${at(4.9).yield_per_kw}`);
say(near(at(4.0).yield_per_kw, 3.9 * 4.0 / 4.6, 0.006) && near(at(5.8).yield_per_kw, 4.2 * 5.8 / 5.2, 0.006), 'quote: a site with less or more sun than both moves in step with its own sun', `${at(4.0).yield_per_kw} and ${at(5.8).yield_per_kw}`);
say(at(4.6).seasons.join() === '1.25,1,0.7,1.05', 'quote: a site with Sydney\'s seasons keeps the normal season spread');
const flat = at(5.2, { seasons: [1.2, 1.0, 0.8, 1.0] }).seasons;
say(near(flat.reduce((t, v) => t + v, 0) / 4, 1, 0.002) && flat[2] > 0.7 && flat[0] < 1.25, 'quote: a site with milder seasons gets a flatter spread that still averages to the year', flat.join(', '));
say(at(4.6).clear_share === Math.round((1 - sum.dullShare) * 100) / 100 && at(4.6).overcast_output === Math.round(sum.dullOutput * 100) / 100, 'quote: clear days and the dull day figure come from the records');
const alike = siteSunFrom({ ...sydney, psh: 5 }, sydney, { ...brisbane, psh: 4.65 });
say(alike.yield_per_kw > 3.5 && alike.yield_per_kw < 5, 'quote: two cities reading alike cannot throw the figure out', `${alike.yield_per_kw}`);

// 5. The estimate takes them, and only for the address they are for.
const address = '1 Example St, Sampletown NSW 2484';
const got = roiSettings({}, 1.382, address, { ...at(4.9), for_address: address });
say(got.sunRecords === '2015 to 2024' && got.yieldPerKw === at(4.9).yield_per_kw && near(got.clearShare, at(4.9).clear_share, 1e-9), 'estimate: the site\'s figures are the normal values on its quote');
say(roiSettings({}, 1.382, '2 Other St, Sydney NSW 2000', { ...at(4.9), for_address: address }).sunRecords === null, 'estimate: figures for another address are not used');
say(roiSettings({ assumptions: { yield_per_kw: 3.6 } }, 1.382, address, { ...at(4.9), for_address: address }).yieldPerKw === 3.6, 'estimate: a figure typed for the quote still wins');

(async () => {
  if (process.argv.includes('--live')) {
    const kept = new Map();
    const memory = { from: () => ({ select: () => ({ eq: (col, cell) => ({ maybeSingle: async () => ({ data: kept.get(cell) || null }) }) }), upsert: async (row) => { kept.set(row.cell, row); return { error: null }; } }) };
    const places = [['Sydney', -33.87, 151.21], ['Brisbane', -27.47, 153.03], ...process.argv.filter(a => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(a)).map(a => [a, ...a.split(',').map(Number)])];
    for (const [name, lat, lng] of places) {
      try {
        const sun = await siteSunFor(memory, lat, lng);
        console.log(`live  ${name}: ${sun.yield_per_kw} kWh a day from each kW (sun ${sun.psh}), seasons ${sun.seasons.join(', ')}, ${Math.round(sun.clear_share * 10)} clear days in 10, a dull day at ${sun.overcast_output}, records ${sun.years}, cell ${sun.cell}`);
      } catch (err) { say(false, `live: ${name}`, err.message); }
    }
  }
  process.exit(failed ? 1 : 0);
})();
