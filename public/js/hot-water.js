// The hot water saving shown on a Hot Water quote (item 113). One file shared by the quote page
// (js/hot-water-card.js, the staff preview) and the client's proposal (quote.html), so both show
// the same maths. Plain script plus the module.exports guard at the bottom: no DOM access at load.
//
// It is a yearly sum, not the hour by hour run the solar estimate does: how much heat the home
// needs, what the old heater pays for it, then the new unit run each way it could be run. Every
// figure is an estimate from the assumptions below and the numbers typed off the bill, and the
// proposal lists them.

const HW_ASSUMPTIONS = {
  litresPerPersonPerDay: 50,   // hot water used per person per day
  riseC: 45,                   // heated from about 15 to 60 degrees
  tankLossKwhPerDay: 1.5,      // heat a storage tank loses standing, per day
  gasEfficiency: 0.75,         // heat out per unit of gas in, for a storage gas heater
  solarHotWaterBoostShare: 0.35, // the share of the heat an old solar hot water system takes from its booster
  heatPumpCop: 3.5,            // heat out per unit of power in, when the model's own figure is not known
  timerSolarShare: 0.7,        // how much of the spare solar a timer in the middle of the day catches (it cannot follow clouds)
  diverterSolarShare: 0.9,     // how much a solar diverter or relay catches (it follows the spare solar)
  mainsGasCentsPerMj: 4.5,     // typed over from their gas bill when there is one
  lpgCentsPerMj: 7.7,          // a 45 kg bottle holds about 2,200 MJ
};

const HW_OLD_HEATERS = ['Electric, full rate', 'Electric, controlled load', 'Gas, mains', 'Gas, LPG bottles', 'Solar hot water', 'None'];

const hwNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Heat the home's hot water needs in a day, in kWh, before any tank loss.
function hwHeatKwhPerDay(people) {
  const a = HW_ASSUMPTIONS;
  return Math.max(1, hwNum(people) || 3) * a.litresPerPersonPerDay * 4.186 * a.riseC / 3600;
}

// What the heater there now costs in a year, in dollars. inputs: see hwEstimate.
function hwOldCostPerYear(inputs) {
  const a = HW_ASSUMPTIONS;
  const heat = hwHeatKwhPerDay(inputs.people) + a.tankLossKwhPerDay;
  const general = hwNum(inputs.generalRate) / 100;
  const controlled = (hwNum(inputs.controlledRate) || hwNum(inputs.generalRate)) / 100;
  switch (inputs.old) {
    case 'Electric, full rate': return heat * general * 365;
    case 'Electric, controlled load': return heat * controlled * 365;
    case 'Gas, mains': return heat * 3.6 / a.gasEfficiency * (hwNum(inputs.gasRate) || a.mainsGasCentsPerMj) / 100 * 365;
    case 'Gas, LPG bottles': return heat * 3.6 / a.gasEfficiency * (hwNum(inputs.gasRate) || a.lpgCentsPerMj) / 100 * 365;
    case 'Solar hot water': return heat * a.solarHotWaterBoostShare * controlled * 365;
    default: return 0; // no heater now: nothing to compare against
  }
}

// inputs: { old (one of HW_OLD_HEATERS), people, generalRate, controlledRate, feedInRate, dayPlanRate (all cents a kWh),
//           gasRate (cents a MJ, blank for the usual figure), spareSolarKwhPerDay (what the home exports now; 0 or blank: no solar) }
// unit: { kind: 'heat_pump' | 'electric', cop, litres, name }
// netPrice: what the client pays after the credits, for the payback.
// Returns { oldPerYear, newKwhPerDay, rows: [{ key, label, perYear, saving, paybackYears }], best, assumptions: [text] }.
function hwEstimate(inputs, unit, netPrice) {
  const a = HW_ASSUMPTIONS;
  inputs = inputs || {};
  unit = unit || {};
  const heatPump = unit.kind !== 'electric';
  const cop = heatPump ? (hwNum(unit.cop) || a.heatPumpCop) : 1;
  const loss = heatPump ? a.tankLossKwhPerDay * 0.7 : a.tankLossKwhPerDay; // a heat pump tank is better lagged
  const newKwh = (hwHeatKwhPerDay(inputs.people) + loss) / cop;
  const general = hwNum(inputs.generalRate) / 100;
  const controlled = hwNum(inputs.controlledRate) / 100;
  const feedIn = hwNum(inputs.feedInRate) / 100;
  const spare = hwNum(inputs.spareSolarKwhPerDay);
  const oldPerYear = hwOldCostPerYear(inputs);

  const rows = [];
  const add = (key, label, perDay) => {
    const perYear = perDay * 365;
    const saving = oldPerYear - perYear;
    rows.push({ key, label, perYear, saving, paybackYears: saving > 0 && hwNum(netPrice) > 0 ? hwNum(netPrice) / saving : null });
  };
  // spare solar used by the heater is no longer sold: it costs the feed-in it would have earned
  const onSolar = (share, restRate) => {
    const covered = Math.min(newKwh, spare * share);
    return covered * feedIn + (newKwh - covered) * restRate;
  };
  if (general > 0) add('any_time', 'On the normal rate, any time of day', newKwh * general);
  if (controlled > 0) add('off_peak', 'On controlled load or off-peak, overnight', newKwh * controlled);
  if (spare > 0 && general > 0) {
    add('timer', 'On a timer in the middle of the day, on your solar', onSolar(a.timerSolarShare, general));
    add('diverter', heatPump ? 'On a solar relay (CatchPower), running when there is spare solar' : 'On a solar diverter (CatchPower), taking the spare solar first', onSolar(a.diverterSolarShare, controlled || general));
  }
  if (inputs.dayPlanRate !== '' && inputs.dayPlanRate != null) {
    add('day_plan', 'On a timer, on a plan with free or cheap daytime power', newKwh * hwNum(inputs.dayPlanRate) / 100);
  }
  const best = rows.slice().sort((x, y) => x.perYear - y.perYear)[0] || null;

  const assumptions = [
    `${Math.max(1, hwNum(inputs.people) || 3)} people using about ${a.litresPerPersonPerDay} litres of hot water each a day, heated by ${a.riseC} degrees.`,
    heatPump ? `The heat pump makes about ${cop} units of heat for each unit of power${hwNum(unit.cop) ? ' (the maker\'s figure)' : ''}; an element makes 1.` : 'An electric storage unit makes 1 unit of heat for each unit of power.',
    `Rates from your bill: ${hwNum(inputs.generalRate)} c a kWh normal${controlled ? `, ${hwNum(inputs.controlledRate)} c controlled load` : ''}${spare > 0 ? `, ${hwNum(inputs.feedInRate)} c paid for solar sent to the grid` : ''}.`,
    spare > 0 ? `Your solar sends about ${Math.round(spare * 10) / 10} kWh a day to the grid now. A timer catches about ${a.timerSolarShare * 100}% of what the heater can use, a diverter or relay about ${a.diverterSolarShare * 100}%. Solar the heater uses is no longer sold, so it is costed at what it would have earned.` : '',
    /^Gas/.test(inputs.old || '') ? `Gas at ${hwNum(inputs.gasRate) || (inputs.old === 'Gas, mains' ? a.mainsGasCentsPerMj : a.lpgCentsPerMj)} c a MJ, and a gas storage heater turning about ${a.gasEfficiency * 100}% of it into hot water. Any gas supply charge you stop paying is extra.` : '',
    'Today\'s prices, with no allowance for price rises. Your own use will differ.',
  ].filter(Boolean);

  return { oldPerYear, newKwhPerDay: newKwh, rows, best, assumptions };
}

const hwDollars = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-AU');

// The saving table, for the staff preview and the client's proposal. chosenKey marks the way the
// unit will be run on this job. esc: the page's own escapeHtml.
function hwTableHtml(est, chosenKey, esc) {
  if (!est || !est.rows.length) return '';
  const row = (r) => `<tr${r.key === chosenKey ? ' style="font-weight:700;"' : ''}>
      <td>${esc(r.label)}${r.key === chosenKey ? ' (how we will set it up)' : ''}</td>
      <td class="num">${hwDollars(r.perYear)}</td>
      <td class="num">${est.oldPerYear > 0 ? (r.saving >= 0 ? hwDollars(r.saving) : '-' + hwDollars(r.saving)) : ''}</td>
      <td class="num">${r.paybackYears ? (Math.round(r.paybackYears * 10) / 10) + ' years' : ''}</td>
    </tr>`;
  return `<table class="qtable hw-table">
    <thead><tr><th>How the new unit runs</th><th class="num">Cost a year</th><th class="num">${est.oldPerYear > 0 ? 'Saved a year' : ''}</th><th class="num">${est.rows.some((r) => r.paybackYears) ? 'Pays for itself in' : ''}</th></tr></thead>
    <tbody>${est.oldPerYear > 0 ? `<tr><td>The heater you have now</td><td class="num">${hwDollars(est.oldPerYear)}</td><td></td><td></td></tr>` : ''}${est.rows.map(row).join('')}</tbody>
  </table>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HW_ASSUMPTIONS, HW_OLD_HEATERS, hwHeatKwhPerDay, hwOldCostPerYear, hwEstimate, hwTableHtml };
}
