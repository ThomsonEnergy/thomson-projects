// Computes real accrued labour cost per stage (and per project) from
// time_entries, using each employee's actual pay rates. Moved server-side
// so profiles.ordinary_rate/rate_1_5x/rate_2x/rate_2_5x (actual wages)
// never has to leave the server at all - every caller gets back only the
// derived $ totals per stage/project, never an individual employee's
// rate. Pay rates stay visible only to admin/finance (Settings > Users &
// Roles, gated there).
//
// Overtime bands per CALENDAR DAY (Australia/Sydney local date), not a
// weekly threshold - each employee's cumulative hours that day, in the
// order they were logged:
//   Public holiday : all hours at the penalty only (rate_2_5x minus
//                    ordinary_rate), since full/part-time staff are paid
//                    the ordinary 1.0x for the day whether they work it or
//                    not, and that base is already in the overheads
//                    on-cost. Casuals get no base, so for them it's the
//                    full rate_2_5x.
//   Sunday         : all hours at OT2 (rate_2x)
//   Saturday       : first 4 hours at OT1 (rate_1_5x), rest at OT2 (rate_2x)
//   Weekday        : first 8 hours ordinary, next 2 hours OT1, rest OT2
// A day spanning multiple projects/entries is banded once across the
// whole day (not per-entry), same as a real payslip would - an entry
// that pushes the day over a threshold gets split across bands.

function localDateKey(iso) {
  // Sydney calendar date as YYYY-MM-DD, DST-safe (Intl handles the
  // offset - naive UTC+10/11 arithmetic would get this wrong twice a year).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function dayOfWeekFromKey(dateKey) {
  // 0=Sunday ... 6=Saturday. Decoded as UTC noon so no server-timezone
  // ambiguity can shift it to the adjacent calendar date.
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}
function entryHours(te) {
  return (new Date(te.clock_out) - new Date(te.clock_in)) / 3600000;
}

// Band boundaries (cumulative hours that day) for one day's shift, given
// its rate keys in order - the building block for both a normal weekday
// (ordinary -> 1.5x -> 2x) and Saturday (1.5x -> 2x, no ordinary band).
function dayBands(dateKey, isPublicHoliday, rates) {
  if (isPublicHoliday) return [{ from: 0, to: Infinity, rate: rates.publicHoliday }];
  const dow = dayOfWeekFromKey(dateKey);
  if (dow === 0) return [{ from: 0, to: Infinity, rate: rates.ot2 }]; // Sunday
  if (dow === 6) return [{ from: 0, to: 4, rate: rates.ot1 }, { from: 4, to: Infinity, rate: rates.ot2 }]; // Saturday
  return [{ from: 0, to: 8, rate: rates.ordinary }, { from: 8, to: 10, rate: rates.ot1 }, { from: 10, to: Infinity, rate: rates.ot2 }]; // weekday
}

// Per-entry cost, keyed by time_entries.id - the building block both
// functions below use. NOT exposed by the aggregate-only endpoint
// (get-accrued-labour-cost.js); only the itemised one
// (get-itemised-labour-cost.js, admin/finance only) hands this back
// directly, since a single entry's cost divided by its hours is
// functionally the same thing as that person's pay rate.
async function computeEntryLabourCosts(supabaseAdmin, timeEntries) {
  const [{ data: allProfiles }, { data: allTiers }, { data: holidays }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, rate_tier_id, employment_type, ordinary_rate, rate_1_5x, rate_2x, rate_2_5x'),
    supabaseAdmin.from('billable_rate_tiers').select('id, sell_rate'),
    supabaseAdmin.from('public_holidays').select('holiday_date'),
  ]);
  const sellRateByProfile = {};
  (allProfiles || []).forEach(p => {
    const tier = (allTiers || []).find(t => t.id === p.rate_tier_id);
    sellRateByProfile[p.id] = tier ? Number(tier.sell_rate) : 0;
  });
  const holidaySet = new Set((holidays || []).map(h => h.holiday_date));

  // The daily threshold is on an employee's TOTAL hours that day across
  // EVERY job, not just whichever project(s) the caller asked about - so
  // for each (employee, local day) the passed-in entries touch, this
  // refetches that employee's WHOLE day (every project) to band
  // correctly, then only the caller's own entries get looked up from the
  // result. A generous UTC window around the target date, filtered down
  // to an exact local-date match in JS, sidesteps hand-computing
  // Sydney's DST-dependent UTC offset.
  const dayKeys = new Set();
  (timeEntries || []).forEach(te => dayKeys.add(`${te.staff_id}|${localDateKey(te.clock_in)}`));

  const costById = new Map();
  await Promise.all([...dayKeys].map(async (key) => {
    const [staffId, dateKey] = key.split('|');
    const windowStart = new Date(`${dateKey}T00:00:00Z`); windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    const windowEnd = new Date(`${dateKey}T00:00:00Z`); windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);
    const { data: windowEntries } = await supabaseAdmin
      .from('time_entries')
      .select('id, clock_in, clock_out')
      .eq('staff_id', staffId)
      .gte('clock_in', windowStart.toISOString())
      .lt('clock_in', windowEnd.toISOString())
      .not('clock_out', 'is', null)
      .order('clock_in', { ascending: true });
    const dayEntries = (windowEntries || []).filter(te => localDateKey(te.clock_in) === dateKey);

    const profile = (allProfiles || []).find(p => p.id === staffId);
    // Falls back to the billable sell rate (times the same multiplier for
    // the OT/public-holiday bands) only when a real pay rate hasn't been
    // set up for this person - an imperfect stand-in, but better than
    // treating unconfigured staff as free.
    const fallbackOrdinary = sellRateByProfile[staffId] || 0;
    const ordinary = Number(profile?.ordinary_rate) || fallbackOrdinary;
    const publicHolidayFull = Number(profile?.rate_2_5x) || fallbackOrdinary * 2.5;
    const rates = {
      ordinary,
      ot1: Number(profile?.rate_1_5x) || fallbackOrdinary * 1.5,
      ot2: Number(profile?.rate_2x) || fallbackOrdinary * 2,
      publicHoliday: profile?.employment_type === 'casual'
        ? publicHolidayFull
        : Math.max(0, publicHolidayFull - ordinary),
    };
    const bands = dayBands(dateKey, holidaySet.has(dateKey), rates);

    let cumulative = 0;
    dayEntries.forEach(te => {
      const hours = entryHours(te);
      const start = cumulative, end = cumulative + hours;
      let cost = 0;
      bands.forEach(band => {
        const overlapStart = Math.max(start, band.from);
        const overlapEnd = Math.min(end, band.to);
        if (overlapEnd > overlapStart) cost += (overlapEnd - overlapStart) * band.rate;
      });
      costById.set(te.id, cost);
      cumulative = end;
    });
  }));
  return costById;
}

// Overhead rates per billable hour, from the Overheads page's own
// calculation (compute_overhead_rates / overhead_people_calc). Direct
// overhead (leave, training, on-costs) is part of what an hour of labour
// really costs, so it is added to labour cost everywhere; indirect
// (non-billable time, office staff) is only ever shown underneath as
// "incl. overheads". Each person's own direct rate where they have one,
// else the company average. Zeros if the rates can't be read, so labour
// falls back to wages only rather than failing.
async function loadOverheadRates(supabaseAdmin) {
  try {
    const [{ data: rates }, { data: people }] = await Promise.all([
      supabaseAdmin.rpc('compute_overhead_rates'),
      supabaseAdmin.rpc('overhead_people_calc'),
    ]);
    const r = (Array.isArray(rates) ? rates[0] : rates) || {};
    const directByProfile = {};
    (people || []).forEach(p => { if (p.direct_rate !== null && p.direct_rate !== undefined) directByProfile[p.profile_id] = Number(p.direct_rate) || 0; });
    return { directRate: Number(r.direct_rate) || 0, indirectRate: Number(r.indirect_rate) || 0, directByProfile };
  } catch (err) {
    console.error('Overhead rates load failed:', err.message);
    return { directRate: 0, indirectRate: 0, directByProfile: {} };
  }
}

// Direct and indirect overhead per time entry, keyed by time_entries.id.
function computeEntryOverheads(timeEntries, rates) {
  const byId = new Map();
  (timeEntries || []).forEach(te => {
    const hours = entryHours(te);
    const direct = rates.directByProfile[te.staff_id] ?? rates.directRate;
    byId.set(te.id, { direct: hours * direct, indirect: hours * rates.indirectRate });
  });
  return byId;
}

// Labour cost here (actualLabourCost / totalActualLabourCost) is wages
// plus direct overhead. Wages and indirect overhead are returned alongside.
// labourBudgetPercent (per stage and per project) is worked out here from
// estimated_labour_cost, because Staff can't read that column and were
// seeing 0% used. Pass rates (from loadOverheadRates) if already loaded.
async function computeAccruedLabourCost(supabaseAdmin, projectIds, { rates: preloadedRates } = {}) {
  const [{ data: allTimeEntries }, { data: centres }, rates] = await Promise.all([
    supabaseAdmin
      .from('time_entries')
      .select('id, project_id, cost_centre_id, selected_cost_centre_ids, staff_id, clock_in, clock_out')
      .in('project_id', projectIds)
      .not('clock_out', 'is', null),
    supabaseAdmin.from('cost_centres').select('id, project_id, estimated_labour_cost').in('project_id', projectIds),
    preloadedRates || loadOverheadRates(supabaseAdmin),
  ]);

  const costById = await computeEntryLabourCosts(supabaseAdmin, allTimeEntries || []);
  const overheadById = computeEntryOverheads(allTimeEntries || [], rates);

  const emptyCentre = () => ({ actualHours: 0, actualLabourCost: 0, actualWages: 0, actualIndirectOverhead: 0 });
  const byProject = {};
  projectIds.forEach(pid => { byProject[pid] = { totalActualLabourCost: 0, totalActualWages: 0, totalIndirectOverhead: 0, totalActualHours: 0, byCentre: {} }; });
  const quotedByCentre = {};
  (centres || []).forEach(c => {
    quotedByCentre[c.id] = Number(c.estimated_labour_cost) || 0;
    if (byProject[c.project_id]) byProject[c.project_id].byCentre[c.id] = emptyCentre();
  });

  (allTimeEntries || []).forEach(te => {
    const wages = costById.get(te.id) || 0;
    const oh = overheadById.get(te.id) || { direct: 0, indirect: 0 };
    const cost = wages + oh.direct;
    const hours = entryHours(te);
    const proj = byProject[te.project_id];
    if (!proj) return;
    proj.totalActualLabourCost += cost;
    proj.totalActualWages += wages;
    proj.totalIndirectOverhead += oh.indirect;
    proj.totalActualHours += hours;

    const centreIds = (te.selected_cost_centre_ids && te.selected_cost_centre_ids.length)
      ? te.selected_cost_centre_ids
      : (te.cost_centre_id ? [te.cost_centre_id] : []);
    // An entry ticked against multiple stages (no explicit split) shares its
    // hours/cost evenly across them - crediting each stage the FULL duration
    // was inflating every stage total (and the project's "hours logged" sum,
    // which adds the per-stage figures back together) by however many
    // stages were ticked.
    const share = centreIds.length > 1 ? 1 / centreIds.length : 1;
    centreIds.forEach(cid => {
      if (!proj.byCentre[cid]) proj.byCentre[cid] = emptyCentre();
      proj.byCentre[cid].actualHours += hours * share;
      proj.byCentre[cid].actualLabourCost += cost * share;
      proj.byCentre[cid].actualWages += wages * share;
      proj.byCentre[cid].actualIndirectOverhead += oh.indirect * share;
    });
  });

  const pct = (actual, quoted) => (quoted > 0 ? Math.round((actual / quoted) * 100) : 0);
  Object.values(byProject).forEach(proj => {
    proj.totalActualHours = Math.round(proj.totalActualHours * 100) / 100;
    let stageActual = 0, stageQuoted = 0;
    Object.entries(proj.byCentre).forEach(([cid, c]) => {
      c.actualHours = Math.round(c.actualHours * 100) / 100;
      const quoted = quotedByCentre[cid] || 0;
      c.labourBudgetPercent = pct(c.actualLabourCost, quoted);
      stageActual += c.actualLabourCost;
      stageQuoted += quoted;
    });
    proj.labourBudgetPercent = pct(stageActual, stageQuoted);
  });

  return byProject;
}

module.exports = { computeAccruedLabourCost, computeEntryLabourCosts, computeEntryOverheads, loadOverheadRates, dayBands, localDateKey, entryHours };
