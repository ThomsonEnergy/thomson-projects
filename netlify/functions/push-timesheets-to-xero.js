// POST /api/push-timesheets-to-xero
// Body: { startDate, endDate }  (YYYY-MM-DD, must match a real pay period
// in Xero - Xero Payroll timesheets are tied to a payroll calendar's exact
// period boundaries, this doesn't try to guess them)
//
// Pushes each staff member's clocked hours in the range as one DRAFT
// timesheet per employee. Each day's hours are banded into the same 4
// award rates payroll costing already uses (ordinary/OT1 1.5x/OT2 2x/
// public holiday 2.5x - see dayBands in compute-labour-cost.js) banded
// across the employee's WHOLE day (every job), same as a real payslip.
// Hours are also split by time_entries.time_category into a small fixed set
// of Xero tracking options - Billable (Jobs), Quoting, Admin, Maintenance,
// TAFE, Training (see trackingLabelFor) - NOT one option per job number. A
// per-job tracking option was tried first but Xero caps a Tracking Category
// at 100 options, and this company's job numbering would blow through that
// within a year; the per-job cost/revenue breakdown already lives properly
// in Thomson Projects' own job costing, so Xero only needs the coarse
// split. (The old combined "Training (TAFE)" and "Non-billable (Office)"
// options are no longer used - anything already in Xero under them stays
// there; new hours post to the new names, created on first use.)
// One TimesheetLine per (tracking option, band) combination that has
// hours, each tagged with the earnings rate mapped to that band in
// Settings > Xero Mapping - so OT hours can post to a different Xero
// account than ordinary hours. Only entries that haven't been pushed
// before are pushed (xero_pushed_at is null), but a day's already-pushed
// hours still count towards its bands and its public holiday, so a re-run
// pays a late-added entry on top of the day already paid (never from
// zero) and never pays the public holiday base day twice.
//
// Also pushes a LAHA (living-away-from-home allowance) line for every
// night flagged at clock-out (time_entries.stayed_overnight, only asked
// for a project with projects.laha_approved set) - NumberOfUnits here is
// nights, not hours, same "units on a TimesheetLine, Xero's own rate
// config decides the $" mechanism as the hourly bands.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');
const { getOrCreateTrackingOptionId } = require('./_shared/xero-tracking');
const { dayBands, localDateKey, entryHours } = require('./_shared/compute-labour-cost');

const BAND_LABELS = ['ordinary', 'ot1', 'ot2', 'publicHoliday'];
const BAND_NAMES = { ordinary: 'Ordinary Hours', ot1: 'OT1 (1.5x)', ot2: 'OT2 (2x)', publicHoliday: 'Public holiday penalty' };

// YYYY-MM-DD plus n calendar days (UTC noon arithmetic, no server-timezone drift).
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Midnight at the start of a Sydney calendar date, as a UTC ISO string.
// DST-safe: reads Sydney's real offset for that moment via Intl.
function sydneyMidnightUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
    const g = (t) => Number(parts.find(p => p.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess);
  return new Date(guess).toISOString();
}

const JOB_LABEL = 'Billable (Jobs)';

function trackingLabelFor(entry) {
  switch (entry.time_category) {
    case 'job': return JOB_LABEL;
    case 'quoting': return 'Quoting';
    case 'maintenance': return 'Maintenance';
    case 'tafe': return 'TAFE';
    case 'training': return 'Training';
    default: return 'Admin'; // 'admin', plus legacy 'office' / 'other'
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { startDate, endDate } = JSON.parse(event.body || '{}');
    if (!startDate || !endDate) {
      return { statusCode: 400, body: JSON.stringify({ error: 'startDate and endDate are required' }) };
    }

    const { data: settings } = await supabaseAdmin
      .from('company_settings')
      .select('xero_ordinary_earnings_rate_id, xero_ot1_earnings_rate_id, xero_ot2_earnings_rate_id, xero_public_holiday_earnings_rate_id, xero_ordinary_office_earnings_rate_id, xero_ot1_office_earnings_rate_id, xero_ot2_office_earnings_rate_id, xero_public_holiday_office_earnings_rate_id, xero_public_holiday_base_earnings_rate_id, xero_laha_earnings_rate_id, xero_tracking_category_id')
      .eq('id', 1)
      .single();
    if (!settings?.xero_ordinary_earnings_rate_id) {
      throw new Error('Set the Ordinary Hours earnings rate ID in Settings > Xero Mapping before pushing timesheets.');
    }

    // Bands with no earnings rate ID of their own fall back to Ordinary
    // Hours rather than blocking the push - tracked so the response can
    // warn that those hours posted at the wrong rate/account.
    const fallbackBands = new Set();
    // Each band has two earnings rates: a "Jobs" one (the original
    // xero_*_earnings_rate_id columns) whose Xero account is a Direct Cost,
    // and an "Office" one (xero_*_office_earnings_rate_id) whose account is
    // an overhead. Xero Payroll posts hours to the earnings rate's own
    // account and tracking never moves them, so this choice is what puts
    // job labour above gross profit and everything else below it. An
    // Office rate not set yet falls back to the Jobs rate for that band.
    const officeFallbackBands = new Set();
    function earningsRateFor(bandLabel, isJob) {
      const jobsRate = {
        ordinary: settings.xero_ordinary_earnings_rate_id,
        ot1: settings.xero_ot1_earnings_rate_id,
        ot2: settings.xero_ot2_earnings_rate_id,
        publicHoliday: settings.xero_public_holiday_earnings_rate_id,
      }[bandLabel];
      if (!isJob) {
        const officeRate = {
          ordinary: settings.xero_ordinary_office_earnings_rate_id,
          ot1: settings.xero_ot1_office_earnings_rate_id,
          ot2: settings.xero_ot2_office_earnings_rate_id,
          publicHoliday: settings.xero_public_holiday_office_earnings_rate_id,
        }[bandLabel];
        if (officeRate) return officeRate;
        officeFallbackBands.add(bandLabel);
      }
      if (jobsRate) return jobsRate;
      fallbackBands.add(bandLabel);
      return settings.xero_ordinary_earnings_rate_id;
    }

    // Cached across every staff member in this run - the 3 tracking
    // options are fixed, no need to hit Xero for the same lookup twice.
    const trackingIdCache = {};
    async function trackingIdFor(label) {
      if (!(label in trackingIdCache)) {
        trackingIdCache[label] = await getOrCreateTrackingOptionId(supabaseAdmin, label);
      }
      return trackingIdCache[label];
    }

    // Sydney pay week: Sydney midnight starting startDate up to (not
    // including) Sydney midnight after endDate, as real UTC instants.
    const { data: allEntries, error: entriesErr } = await supabaseAdmin
      .from('time_entries')
      .select('*, profiles(xero_employee_id, full_name)')
      .gte('clock_in', sydneyMidnightUtc(startDate))
      .lt('clock_in', sydneyMidnightUtc(addDays(endDate, 1)))
      .not('clock_out', 'is', null);
    if (entriesErr) throw entriesErr;
    // Entries already pushed (and ServiceM8 imports, paid through Xero
    // already) are never pushed again, but their hours stay in the picture:
    // a re-run bands a late-added entry on top of the day already paid, and
    // sees a public holiday that was worked as worked.
    const isPushed = (e) => !!e.xero_pushed_at || !!e.sm8_activity_uuid;
    const entries = (allEntries || []).filter(e => !isPushed(e));
    // staffId -> Sydney date -> paid hours already pushed for that day
    const pushedHoursByStaffDay = {};
    (allEntries || []).filter(isPushed).forEach(e => {
      const staffDays = (pushedHoursByStaffDay[e.staff_id] ||= {});
      const key = localDateKey(e.clock_in);
      staffDays[key] = (staffDays[key] || 0) + entryHours(e);
    });

    const { data: holidays } = await supabaseAdmin.from('public_holidays').select('holiday_date');
    const holidaySet = new Set((holidays || []).map(h => h.holiday_date));

    // Public holidays are paid as base + penalty (migration 152). The base
    // (ordinary rate, overhead account) is owed to full-time staff for a
    // weekday public holiday even if they don't work it, so those days are
    // pushed below as 8 base hours. public_holiday_pay_pushes stops a re-run
    // paying the same day twice. Part-timers' hours vary, so they're listed
    // as a warning to add by hand in Xero instead.
    const FULL_TIME_PUBLIC_HOLIDAY_HOURS = 8;
    const weekdayHolidaysInRange = [...holidaySet].filter(d => d >= startDate && d <= endDate)
      .filter(d => { const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; });
    const { data: staffProfiles } = await supabaseAdmin.from('profiles')
      .select('id, full_name, xero_employee_id, employment_type, employment_start_date, active');
    const profileById = Object.fromEntries((staffProfiles || []).map(p => [p.id, p]));
    const alreadyPaidHoliday = new Set();
    if (weekdayHolidaysInRange.length) {
      const { data: paid } = await supabaseAdmin.from('public_holiday_pay_pushes')
        .select('profile_id, holiday_date').in('holiday_date', weekdayHolidaysInRange);
      (paid || []).forEach(r => alreadyPaidHoliday.add(`${r.profile_id}|${r.holiday_date}`));
    }
    // A holiday still to be dealt with for this person: not pushed before,
    // and not from before they started (nobody is owed a day they were not
    // yet employed for).
    const holidayPending = (profileId, profile, d) => !alreadyPaidHoliday.has(`${profileId}|${d}`)
      && !(profile.employment_start_date && profile.employment_start_date > d);

    const byStaff = {};
    entries.forEach(e => { (byStaff[e.staff_id] ||= []).push(e); });
    // Full-timers with an unpaid weekday public holiday in range get a
    // timesheet even if they logged no hours at all this period.
    (staffProfiles || []).filter(p => p.active && p.xero_employee_id && p.employment_type === 'full_time')
      .forEach(p => {
        if (weekdayHolidaysInRange.some(d => holidayPending(p.id, p, d))) byStaff[p.id] ||= [];
      });

    if (!Object.keys(byStaff).length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pushed: 0, message: 'No unpushed entries in that range.' }) };
    }

    const results = [];
    const skipped = [];
    const warnings = [];
    const pushedEntryIds = [];
    const paidHolidayRows = [];

    for (const staffId of Object.keys(byStaff)) {
      const staffEntries = byStaff[staffId];
      const staffProfile = profileById[staffId] || staffEntries[0]?.profiles || {};
      const employeeId = staffProfile.xero_employee_id;
      const staffName = staffProfile.full_name || staffId;

      if (!employeeId) {
        skipped.push(`${staffName} has no Xero Employee ID set (Settings > Users & Roles)`);
        continue;
      }

      // Xero wants a fixed-length NumberOfUnits array, one slot per day of
      // the timesheet period, in order from startDate to endDate - shared
      // across every line below.
      const days = [];
      for (let d = startDate; d <= endDate; d = addDays(d, 1)) days.push(d);
      const daySet = new Set(days);

      // Band each CALENDAR DAY's hours (Sydney local date) across the
      // employee's WHOLE day - every entry together, same as payroll
      // costing (dayBands in compute-labour-cost.js) - then attribute
      // each band's hours to whichever tracking option (billable/office/
      // training) the entry that earned them belongs to.
      // trackingLabel -> bandLabel -> dateKey -> hours
      const unitsByLabelBandDay = {};
      const byDay = {};
      staffEntries.forEach(e => { (byDay[localDateKey(e.clock_in)] ||= []).push(e); });
      const pushedHoursByDay = pushedHoursByStaffDay[staffId] || {};
      Object.keys(byDay).forEach(dateKey => {
        const dayEntries = byDay[dateKey].slice().sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
        const bands = dayBands(dateKey, holidaySet.has(dateKey), { ordinary: 'ordinary', ot1: 'ot1', ot2: 'ot2', publicHoliday: 'publicHoliday' });
        // Hours already pushed for this day took the first bands when they
        // were paid, so the new hours start where those left off.
        let cumulative = pushedHoursByDay[dateKey] || 0;
        dayEntries.forEach(e => {
          const hours = entryHours(e);
          const start = cumulative, entryEnd = cumulative + hours;
          const label = trackingLabelFor(e);
          bands.forEach(band => {
            const overlapStart = Math.max(start, band.from);
            const overlapEnd = Math.min(entryEnd, band.to);
            if (overlapEnd > overlapStart) {
              const labelBands = (unitsByLabelBandDay[label] ||= {});
              const bandDays = (labelBands[band.rate] ||= {});
              bandDays[dateKey] = (bandDays[dateKey] || 0) + (overlapEnd - overlapStart);
            }
          });
          cumulative = entryEnd;
        });
      });

      // LAHA nights - separate from the hour bands above since units here
      // are "1 per night stayed", not hours. Already at most one flagged
      // entry per (project, day) by construction (clock-out only asks
      // once per day per project), so no dedupe needed.
      const lahaNightsByLabelDay = {};
      staffEntries.filter(e => e.stayed_overnight === true).forEach(e => {
        const label = trackingLabelFor(e);
        const labelDays = (lahaNightsByLabelDay[label] ||= {});
        labelDays[localDateKey(e.clock_in)] = 1;
      });
      const hasLahaNights = Object.values(lahaNightsByLabelDay).some(days => Object.values(days).some(n => n > 0));
      // Unlike the OT/PH rate fallback (still pays the right total, just
      // at the wrong $/hr), there's no safe fallback for a missing LAHA
      // rate - once these hours are pushed and marked xero_pushed_at,
      // the flagged night can never be reconsidered. Skip this person's
      // WHOLE push rather than silently lose the allowance.
      if (hasLahaNights && !settings.xero_laha_earnings_rate_id) {
        skipped.push(`${staffName}: has LAHA nights logged but no LAHA earnings rate ID is set (Settings > Xero Mapping) - set that first so the allowance isn't lost.`);
        continue;
      }

      // Unworked weekday public holidays still owed to this person, and the
      // worked ones (their base is paid per hour next to the penalty below,
      // and recorded in public_holiday_pay_pushes once pushed so a re-run
      // never adds the unworked base day on top).
      const unworkedHolidays = [];
      const workedHolidays = [];
      weekdayHolidaysInRange.forEach(d => {
        if (!holidayPending(staffId, staffProfile, d)) return;
        const workedHours = (byDay[d] || []).reduce((s, e) => s + entryHours(e), 0) + (pushedHoursByDay[d] || 0);
        if (workedHours > 0) workedHolidays.push({ date: d, hours: workedHours });
        if (staffProfile.employment_type === 'full_time') {
          if (workedHours === 0) unworkedHolidays.push(d);
          else if (workedHours < FULL_TIME_PUBLIC_HOLIDAY_HOURS) warnings.push(`${staffName} worked ${Math.round(workedHours * 100) / 100}h on the ${d} public holiday - check whether a top-up to ${FULL_TIME_PUBLIC_HOLIDAY_HOURS}h base pay is owed and add it in Xero if so.`);
        } else if (staffProfile.employment_type === 'part_time' && workedHours === 0) {
          warnings.push(`${staffName} (part-time) didn't work the ${d} public holiday - if it was one of their normal days, add their usual hours on the "Public holiday" pay item in Xero.`);
        }
      });
      const hasPublicHolidayHours = Object.values(unitsByLabelBandDay).some(b => b.publicHoliday);
      // No safe fallback: without the base rate, worked public holiday hours
      // would only get the penalty (1.5x) and unworked days nothing at all.
      if ((hasPublicHolidayHours || unworkedHolidays.length) && !settings.xero_public_holiday_base_earnings_rate_id) {
        skipped.push(`${staffName}: has public holiday pay this period but no "Public holiday (base)" earnings rate is set (Settings > Xero Mapping) - set that first so it isn't underpaid.`);
        continue;
      }

      const timesheetLines = [];
      let allEntriesForThisStaff = [];
      for (const label of Object.keys(unitsByLabelBandDay)) {
        const trackingItemId = await trackingIdFor(label);

        let labelHasLine = false;
        BAND_LABELS.forEach(bandLabel => {
          const bandDays = unitsByLabelBandDay[label][bandLabel];
          if (!bandDays) return;
          const numberOfUnits = days.map(d => Math.round(((bandDays[d] || 0)) * 100) / 100);
          if (numberOfUnits.every(n => n === 0)) return;
          timesheetLines.push({
            EarningsRateID: earningsRateFor(bandLabel, label === JOB_LABEL),
            NumberOfUnits: numberOfUnits,
            TrackingItemID: trackingItemId || undefined,
          });
          // Public holiday hours worked: the line above is the penalty only,
          // so the same hours also go on the base rate (ordinary rate).
          if (bandLabel === 'publicHoliday') {
            timesheetLines.push({
              EarningsRateID: settings.xero_public_holiday_base_earnings_rate_id,
              NumberOfUnits: numberOfUnits,
              TrackingItemID: trackingItemId || undefined,
            });
          }
          labelHasLine = true;
        });

        const lahaDays = lahaNightsByLabelDay[label];
        if (lahaDays) {
          const numberOfUnits = days.map(d => lahaDays[d] || 0);
          if (numberOfUnits.some(n => n > 0)) {
            timesheetLines.push({
              EarningsRateID: settings.xero_laha_earnings_rate_id,
              NumberOfUnits: numberOfUnits,
              TrackingItemID: trackingItemId || undefined,
            });
            labelHasLine = true;
          }
        }

        if (labelHasLine) {
          // Only mark entries whose Sydney day is actually in this timesheet,
          // so hours outside the pushed days are never marked paid.
          allEntriesForThisStaff = allEntriesForThisStaff.concat(staffEntries.filter(e => trackingLabelFor(e) === label && daySet.has(localDateKey(e.clock_in))));
        }
      }

      if (unworkedHolidays.length) {
        timesheetLines.push({
          EarningsRateID: settings.xero_public_holiday_base_earnings_rate_id,
          NumberOfUnits: days.map(d => unworkedHolidays.includes(d) ? FULL_TIME_PUBLIC_HOLIDAY_HOURS : 0),
        });
      }

      if (!timesheetLines.length) { continue; }

      try {
        // Payroll AU wants a bare JSON array as the request body (same as
        // Employees) - wrapping the timesheet in a plain object gets
        // rejected as a deserialization error before Xero looks at it.
        const result = await xeroRequest('payroll.au', 'Timesheets', {
          method: 'POST',
          body: [{
            EmployeeID: employeeId,
            StartDate: startDate,
            EndDate: endDate,
            Status: 'DRAFT',
            TimesheetLines: timesheetLines,
          }],
        });
        const timesheetId = result?.Timesheets?.[0]?.TimesheetID;
        results.push({ staff: staffName, timesheetId });
        allEntriesForThisStaff.forEach(e => pushedEntryIds.push(e.id));
        unworkedHolidays.forEach(d => paidHolidayRows.push({ profile_id: staffId, holiday_date: d, hours: FULL_TIME_PUBLIC_HOLIDAY_HOURS }));
        workedHolidays.forEach(w => paidHolidayRows.push({ profile_id: staffId, holiday_date: w.date, hours: Math.round(w.hours * 100) / 100 }));
      } catch (err) {
        skipped.push(`${staffName}: ${err.message}`);
      }
    }

    if (pushedEntryIds.length) {
      await supabaseAdmin
        .from('time_entries')
        .update({ xero_pushed_at: new Date().toISOString() })
        .in('id', pushedEntryIds);
    }
    if (paidHolidayRows.length) {
      await supabaseAdmin.from('public_holiday_pay_pushes').upsert(paidHolidayRows, { onConflict: 'profile_id,holiday_date' });
    }

    warnings.push(
      ...[...fallbackBands].map(b => `${BAND_NAMES[b]} has no earnings rate ID set - those hours were pushed at the Ordinary Hours rate instead (Settings > Xero Mapping).`),
      ...[...officeFallbackBands].map(b => `${BAND_NAMES[b]} (Office) has no earnings rate ID set - non-job hours in that band were pushed to the Jobs rate, so they landed in Direct Costs (Settings > Xero Mapping).`),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, pushed: results.length, results, skipped, warnings }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
