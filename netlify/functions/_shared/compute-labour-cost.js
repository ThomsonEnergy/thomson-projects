// Computes real accrued labour cost per stage (and per project) from
// time_entries, using each employee's actual pay rates - the same
// weekly-overtime-banded calculation project.html and projects.html used
// to run client-side. Moved server-side so profiles.ordinary_rate/
// rate_1_5x/rate_2x (actual wages) never has to leave the server at all -
// every caller gets back only the derived $ totals per stage/project,
// never an individual employee's rate. Pay rates stay visible only to
// admin/finance (Settings > Users & Roles, gated there).
//
// Overtime is a threshold on the employee's TOTAL hours that week across
// EVERY job, not just one project, so this pulls each touched employee's
// full pay week (every project) to band correctly, then attributes only
// the portions belonging to the requested project(s)' entries.

function getPayWeekStart(d) {
  const diff = (d.getDay() - 5 + 7) % 7; // days since the most recent Friday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
}
function entryHours(te) {
  return (new Date(te.clock_out) - new Date(te.clock_in)) / 3600000;
}

// Per-entry cost, keyed by time_entries.id - the building block both
// functions below use. NOT exposed by the aggregate-only endpoint
// (get-accrued-labour-cost.js); only the itemised one
// (get-itemised-labour-cost.js, admin/finance only) hands this back
// directly, since a single entry's cost divided by its hours is
// functionally the same thing as that person's pay rate.
async function computeEntryLabourCosts(supabaseAdmin, timeEntries) {
  const [{ data: allProfiles }, { data: allTiers }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, rate_tier_id, ordinary_rate, rate_1_5x, rate_2x'),
    supabaseAdmin.from('billable_rate_tiers').select('id, sell_rate'),
  ]);
  const sellRateByProfile = {};
  (allProfiles || []).forEach(p => {
    const tier = (allTiers || []).find(t => t.id === p.rate_tier_id);
    sellRateByProfile[p.id] = tier ? Number(tier.sell_rate) : 0;
  });

  // One (employee, pay week) fetch per unique combination the passed-in
  // entries touch - typically a handful, not per-entry.
  const weekKeys = new Set();
  (timeEntries || []).forEach(te => {
    weekKeys.add(`${te.staff_id}|${getPayWeekStart(new Date(te.clock_in)).toISOString()}`);
  });
  const costById = new Map();
  await Promise.all([...weekKeys].map(async (key) => {
    const [staffId, wkIso] = key.split('|');
    const wkStart = new Date(wkIso);
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkEnd.getDate() + 7);
    const { data: weekEntries } = await supabaseAdmin
      .from('time_entries')
      .select('id, clock_in, clock_out')
      .eq('staff_id', staffId)
      .gte('clock_in', wkStart.toISOString())
      .lt('clock_in', wkEnd.toISOString())
      .not('clock_out', 'is', null)
      .order('clock_in', { ascending: true });

    const profile = (allProfiles || []).find(p => p.id === staffId);
    // Falls back to the billable sell rate (times the same multiplier for
    // the 1.5x/2x bands) only when a real pay rate hasn't been set up for
    // this person - an imperfect stand-in, but better than treating
    // unconfigured staff as free.
    const fallbackOrdinary = sellRateByProfile[staffId] || 0;
    const ordinaryRate = Number(profile?.ordinary_rate) || fallbackOrdinary;
    const rate15 = Number(profile?.rate_1_5x) || fallbackOrdinary * 1.5;
    const rate2 = Number(profile?.rate_2x) || fallbackOrdinary * 2;
    const bands = [{ from: 0, to: 38, rate: ordinaryRate }, { from: 38, to: 48, rate: rate15 }, { from: 48, to: Infinity, rate: rate2 }];

    let cumulative = 0;
    (weekEntries || []).forEach(te => {
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

async function computeAccruedLabourCost(supabaseAdmin, projectIds) {
  const { data: allTimeEntries } = await supabaseAdmin
    .from('time_entries')
    .select('id, project_id, cost_centre_id, selected_cost_centre_ids, staff_id, clock_in, clock_out')
    .in('project_id', projectIds)
    .not('clock_out', 'is', null);

  const costById = await computeEntryLabourCosts(supabaseAdmin, allTimeEntries || []);

  const byProject = {};
  projectIds.forEach(pid => { byProject[pid] = { totalActualLabourCost: 0, totalActualHours: 0, byCentre: {} }; });

  (allTimeEntries || []).forEach(te => {
    const cost = costById.get(te.id) || 0;
    const hours = entryHours(te);
    const proj = byProject[te.project_id];
    if (!proj) return;
    proj.totalActualLabourCost += cost;
    proj.totalActualHours += hours;

    const centreIds = (te.selected_cost_centre_ids && te.selected_cost_centre_ids.length)
      ? te.selected_cost_centre_ids
      : (te.cost_centre_id ? [te.cost_centre_id] : []);
    centreIds.forEach(cid => {
      if (!proj.byCentre[cid]) proj.byCentre[cid] = { actualHours: 0, actualLabourCost: 0 };
      proj.byCentre[cid].actualHours += hours;
      proj.byCentre[cid].actualLabourCost += cost;
    });
  });

  Object.values(byProject).forEach(proj => {
    proj.totalActualHours = Math.round(proj.totalActualHours * 100) / 100;
    Object.values(proj.byCentre).forEach(c => { c.actualHours = Math.round(c.actualHours * 100) / 100; });
  });

  return byProject;
}

module.exports = { computeAccruedLabourCost, computeEntryLabourCosts };
