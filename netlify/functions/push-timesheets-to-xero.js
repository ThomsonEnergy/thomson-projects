// POST /api/push-timesheets-to-xero
// Body: { startDate, endDate }  (YYYY-MM-DD, must match a real pay period
// in Xero - Xero Payroll timesheets are tied to a payroll calendar's exact
// period boundaries, this doesn't try to guess them)
//
// Pushes each staff member's clocked hours in the range as one DRAFT
// timesheet per employee, one line per day worked, tagged with the job
// tracking option where a stage was recorded. Only entries that haven't
// been pushed before are included (xero_pushed_at is null) - safe to
// re-run without double-pushing hours already sent.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');

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
      .select('xero_ordinary_earnings_rate_id, xero_tracking_category_id')
      .eq('id', 1)
      .single();
    if (!settings?.xero_ordinary_earnings_rate_id) {
      throw new Error('Set the Ordinary Hours earnings rate ID in Settings > Xero Mapping before pushing timesheets.');
    }

    const { data: entries, error: entriesErr } = await supabaseAdmin
      .from('time_entries')
      .select('*, profiles(xero_employee_id, full_name)')
      .gte('clock_in', `${startDate}T00:00:00`)
      .lte('clock_in', `${endDate}T23:59:59`)
      .not('clock_out', 'is', null)
      .is('xero_pushed_at', null);
    if (entriesErr) throw entriesErr;
    if (!entries.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pushed: 0, message: 'No unpushed entries in that range.' }) };
    }

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

      // Total minutes worked per calendar day in range.
      const minutesByDay = {};
      staffEntries.forEach(e => {
        const day = dateOnly(e.clock_in);
        const mins = (new Date(e.clock_out) - new Date(e.clock_in)) / 60000;
        minutesByDay[day] = (minutesByDay[day] || 0) + mins;
      });

      // Xero wants a fixed-length NumberOfUnits array, one slot per day of
      // the timesheet period, in order from startDate to endDate.
      const days = [];
      let cursor = new Date(`${startDate}T00:00:00`);
      const end = new Date(`${endDate}T00:00:00`);
      while (cursor <= end) {
        days.push(dateOnly(cursor.toISOString()));
        cursor.setDate(cursor.getDate() + 1);
      }
      const numberOfUnits = days.map(d => Math.round(((minutesByDay[d] || 0) / 60) * 100) / 100);

      if (numberOfUnits.every(n => n === 0)) { continue; }

      const timesheetLine = {
        EarningsRateID: settings.xero_ordinary_earnings_rate_id,
        NumberOfUnits: numberOfUnits,
      };

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
            TimesheetLines: [timesheetLine],
          }],
        });
        const timesheetId = result?.Timesheets?.[0]?.TimesheetID;
        results.push({ staff: staffName, timesheetId });
        staffEntries.forEach(e => pushedEntryIds.push(e.id));
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

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, pushed: results.length, results, skipped }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
