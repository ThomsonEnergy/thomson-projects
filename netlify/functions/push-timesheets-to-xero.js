// POST /api/push-timesheets-to-xero
// Body: { startDate, endDate }  (YYYY-MM-DD, must match a real pay period
// in Xero - Xero Payroll timesheets are tied to a payroll calendar's exact
// period boundaries, this doesn't try to guess them)
//
// Pushes each staff member's clocked hours in the range as one DRAFT
// timesheet per employee. Each day's hours are banded into the same 4
// award rates payroll costing already uses (ordinary/OT1 1.5x/OT2 2x/
// public holiday 2.5x - see dayBands in compute-labour-cost.js), banded
// across the employee's WHOLE day (every job), same as a real payslip.
// One TimesheetLine per (job, band) combination that has hours, each
// tagged with that job's tracking option (required per line once
// tracking is turned on for timesheets in Xero's Payroll Settings) and
// the earnings rate mapped to that band in Settings > Xero Mapping - so
// OT hours can post to a different Xero account than ordinary hours.
// Only entries that haven't been pushed before are included
// (xero_pushed_at is null) - safe to re-run without double-pushing hours
// already sent.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');
const { getOrCreateTrackingOptionId } = require('./_shared/xero-tracking');
const { dayBands, localDateKey, entryHours } = require('./_shared/compute-labour-cost');

const OFFICE_TRACKING_OPTION_NAME = 'Office / General';
const BAND_LABELS = ['ordinary', 'ot1', 'ot2', 'publicHoliday'];
const BAND_NAMES = { ordinary: 'Ordinary Hours', ot1: 'OT1 (1.5x)', ot2: 'OT2 (2x)', publicHoliday: 'Public holiday (2.5x)' };

function dateOnly(iso) {
  return iso.slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
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
      .select('xero_ordinary_earnings_rate_id, xero_ot1_earnings_rate_id, xero_ot2_earnings_rate_id, xero_public_holiday_earnings_rate_id, xero_tracking_category_id')
      .eq('id', 1)
      .single();
    if (!settings?.xero_ordinary_earnings_rate_id) {
      throw new Error('Set the Ordinary Hours earnings rate ID in Settings > Xero Mapping before pushing timesheets.');
    }

    // Bands with no earnings rate ID of their own fall back to Ordinary
    // Hours rather than blocking the push - tracked so the response can
    // warn that those hours posted at the wrong rate/account.
    const fallbackBands = new Set();
    function earningsRateFor(bandLabel) {
      const direct = {
        ordinary: settings.xero_ordinary_earnings_rate_id,
        ot1: settings.xero_ot1_earnings_rate_id,
        ot2: settings.xero_ot2_earnings_rate_id,
        publicHoliday: settings.xero_public_holiday_earnings_rate_id,
      }[bandLabel];
      if (direct) return direct;
      fallbackBands.add(bandLabel);
      return settings.xero_ordinary_earnings_rate_id;
    }

    const { data: entries, error: entriesErr } = await supabaseAdmin
      .from('time_entries')
      .select('*, profiles(xero_employee_id, full_name), projects(job_number)')
      .gte('clock_in', `${startDate}T00:00:00`)
      .lte('clock_in', `${endDate}T23:59:59`)
      .not('clock_out', 'is', null)
      .is('xero_pushed_at', null);
    if (entriesErr) throw entriesErr;
    if (!entries.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pushed: 0, message: 'No unpushed entries in that range.' }) };
    }

    const { data: holidays } = await supabaseAdmin.from('public_holidays').select('holiday_date');
    const holidaySet = new Set((holidays || []).map(h => h.holiday_date));

    const byStaff = {};
    entries.forEach(e => { (byStaff[e.staff_id] ||= []).push(e); });

    const results = [];
    const skipped = [];
    const pushedEntryIds = [];

    for (const staffId of Object.keys(byStaff)) {
      const staffEntries = byStaff[staffId];
      const employeeId = staffEntries[0].profiles?.xero_employee_id;
      const staffName = staffEntries[0].profiles?.full_name || staffId;

      if (!employeeId) {
        skipped.push(`${staffName} has no Xero Employee ID set (Settings > Users & Roles)`);
        continue;
      }

      // Xero wants a fixed-length NumberOfUnits array, one slot per day of
      // the timesheet period, in order from startDate to endDate - shared
      // across every line below.
      const days = [];
      let cursor = new Date(`${startDate}T00:00:00`);
      const end = new Date(`${endDate}T00:00:00`);
      while (cursor <= end) {
        days.push(dateOnly(cursor.toISOString()));
        cursor.setDate(cursor.getDate() + 1);
      }

      const jobNumberByKey = {};
      staffEntries.forEach(e => { jobNumberByKey[e.project_id || 'none'] = e.projects?.job_number; });

      // Band each CALENDAR DAY's hours (Sydney local date) across the
      // employee's WHOLE day - every job together, same as payroll costing
      // (dayBands in compute-labour-cost.js) - then attribute each band's
      // hours back to whichever job the entry that earned them was
      // logged against. jobKey -> bandLabel -> dateKey -> hours.
      const unitsByJobBandDay = {};
      const byDay = {};
      staffEntries.forEach(e => { (byDay[localDateKey(e.clock_in)] ||= []).push(e); });
      Object.keys(byDay).forEach(dateKey => {
        const dayEntries = byDay[dateKey].slice().sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
        const bands = dayBands(dateKey, holidaySet.has(dateKey), { ordinary: 'ordinary', ot1: 'ot1', ot2: 'ot2', publicHoliday: 'publicHoliday' });
        let cumulative = 0;
        dayEntries.forEach(e => {
          const hours = entryHours(e);
          const start = cumulative, entryEnd = cumulative + hours;
          const jobKey = e.project_id || 'none';
          bands.forEach(band => {
            const overlapStart = Math.max(start, band.from);
            const overlapEnd = Math.min(entryEnd, band.to);
            if (overlapEnd > overlapStart) {
              const jobBands = (unitsByJobBandDay[jobKey] ||= {});
              const bandDays = (jobBands[band.rate] ||= {});
              bandDays[dateKey] = (bandDays[dateKey] || 0) + (overlapEnd - overlapStart);
            }
          });
          cumulative = entryEnd;
        });
      });

      const timesheetLines = [];
      let allEntriesForThisStaff = [];
      for (const jobKey of Object.keys(unitsByJobBandDay)) {
        const jobNumber = jobNumberByKey[jobKey];
        const trackingItemId = await getOrCreateTrackingOptionId(supabaseAdmin, jobNumber ? `Job ${jobNumber}` : OFFICE_TRACKING_OPTION_NAME);

        let jobHasLine = false;
        BAND_LABELS.forEach(bandLabel => {
          const bandDays = unitsByJobBandDay[jobKey][bandLabel];
          if (!bandDays) return;
          const numberOfUnits = days.map(d => Math.round(((bandDays[d] || 0)) * 100) / 100);
          if (numberOfUnits.every(n => n === 0)) return;
          timesheetLines.push({
            EarningsRateID: earningsRateFor(bandLabel),
            NumberOfUnits: numberOfUnits,
            TrackingItemID: trackingItemId || undefined,
          });
          jobHasLine = true;
        });
        if (jobHasLine) {
          allEntriesForThisStaff = allEntriesForThisStaff.concat(staffEntries.filter(e => (e.project_id || 'none') === jobKey));
        }
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

    const warnings = [...fallbackBands].map(b => `${BAND_NAMES[b]} has no earnings rate ID set - those hours were pushed at the Ordinary Hours rate instead (Settings > Xero Mapping).`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, pushed: results.length, results, skipped, warnings }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
