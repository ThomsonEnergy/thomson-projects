// POST /api/push-pay-rates-to-xero
// Admin/finance-only. Pushes each employee's 4 contract pay rates from the
// app into their EXISTING Xero Payroll AU pay template, so a pay rise is
// entered once (on the staff profile) and sent to Xero from here.
//
// Body: { profileId } for one person, or { all: true } for every active,
// linked staff member.
//
// How it maps: Settings > Xero Mapping already stores one Xero earnings
// rate per pay band (xero_ordinary/ot1/ot2/public_holiday_earnings_rate_id),
// the same ones push-timesheets-to-xero.js puts hours against. Each band's
// earnings rate must be set up in Xero as "Rate per unit" (hours) so the
// pay template can carry a per-person rate. This sets, per band, a pay
// template line with CalculationType ENTEREARNINGSRATE and the person's
// own $/hr from profiles:
//   ordinary -> ordinary_rate, ot1 -> rate_1_5x, ot2 -> rate_2x,
//   public holiday -> rate_2_5x
//
// Safety: it reads the employee's current pay template first and sends the
// whole thing back with only those band lines changed or added, so super,
// leave, deductions, reimbursements and any other earnings lines (e.g. the
// LAHA allowance) are kept exactly as they are. It sends EmployeeID, so it
// can only ever update an existing employee, never create one.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');

// Each band has a Jobs earnings rate (Direct Costs account) and an Office
// one (overheads account, migration 151); both get the same $/hr, since a
// person's contract rate doesn't change with the kind of work.
const BANDS = [
  { key: 'ordinary', label: 'Ordinary', rateCol: 'ordinary_rate', idCol: 'xero_ordinary_earnings_rate_id', officeIdCol: 'xero_ordinary_office_earnings_rate_id' },
  { key: 'ot1', label: 'Overtime - first 2hrs', rateCol: 'rate_1_5x', idCol: 'xero_ot1_earnings_rate_id', officeIdCol: 'xero_ot1_office_earnings_rate_id' },
  { key: 'ot2', label: 'Overtime - after that', rateCol: 'rate_2x', idCol: 'xero_ot2_earnings_rate_id', officeIdCol: 'xero_ot2_office_earnings_rate_id' },
  { key: 'publicHoliday', label: 'Public holiday', rateCol: 'rate_2_5x', idCol: 'xero_public_holiday_earnings_rate_id', officeIdCol: 'xero_public_holiday_office_earnings_rate_id' },
];

// Payroll AU 1.0 returns dates as "/Date(1234567890000+0000)/"; send them
// back as plain ISO dates.
function xeroDateToIso(v) {
  const m = typeof v === 'string' && v.match(/\/Date\((-?\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) + 'T00:00:00' : v;
}

async function pushOne(supabaseAdmin, profile, settings) {
  const sent = {};
  const skipped = [];
  const bandLines = [];
  for (const band of BANDS) {
    const rate = Number(profile[band.rateCol]);
    if (!(rate > 0)) { skipped.push(`${band.label} (no rate on their profile)`); continue; }
    let any = false;
    for (const [col, kind] of [[band.idCol, 'Jobs'], [band.officeIdCol, 'Office']]) {
      if (settings[col]) { bandLines.push({ earningsRateId: settings[col], rate }); any = true; }
      else skipped.push(`${band.label} - ${kind} (no Xero earnings rate chosen in Settings > Xero Mapping)`);
    }
    if (any) sent[band.key] = rate;
  }
  if (!bandLines.length) throw new Error(`Nothing to push: ${skipped.join('; ')}`);

  const current = (await xeroRequest('payroll.au', `Employees/${profile.xero_employee_id}`))?.Employees?.[0];
  if (!current) throw new Error('The linked Xero employee could not be found. Clear the Xero Employee ID and link again.');

  const template = current.PayTemplate || {};
  const lines = [...(template.EarningsLines || [])];
  for (const { earningsRateId, rate } of bandLines) {
    const i = lines.findIndex(l => l.EarningsRateID === earningsRateId);
    // Keep any other settings already on the line (e.g. hours per week),
    // only the calculation type and $/hr change.
    const updated = { ...(i >= 0 ? lines[i] : { EarningsRateID: earningsRateId }), CalculationType: 'ENTEREARNINGSRATE', RatePerUnit: rate };
    delete updated.AnnualSalary;
    if (i >= 0) lines[i] = updated; else lines.push(updated);
  }

  const update = {
    EmployeeID: profile.xero_employee_id,
    FirstName: current.FirstName,
    LastName: current.LastName,
    DateOfBirth: xeroDateToIso(current.DateOfBirth) || undefined,
    HomeAddress: current.HomeAddress || undefined,
    // The employee's main ordinary earnings rate (used for STP and leave)
    // follows the Ordinary - Jobs rate chosen in Settings > Xero Mapping, so
    // moving to new pay items is a clean swap rather than leaving people on
    // an old one. Falls back to whatever Xero has if none is chosen.
    OrdinaryEarningsRateID: settings.xero_ordinary_earnings_rate_id || current.OrdinaryEarningsRateID || undefined,
    PayTemplate: { ...template, EarningsLines: lines },
  };
  await xeroRequest('payroll.au', 'Employees', { method: 'POST', body: [update] });

  await supabaseAdmin.from('profiles').update({
    xero_rates_pushed: sent, xero_rates_pushed_at: new Date().toISOString(), xero_payroll_error: null,
  }).eq('id', profile.id);
  return { sent, skipped };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Admin or finance access required' }) };
  }
  const { supabaseAdmin } = auth;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid request body' }) };
  }

  try {
    const { data: settings } = await supabaseAdmin.from('company_settings')
      .select(BANDS.flatMap(b => [b.idCol, b.officeIdCol]).join(', ')).eq('id', 1).single();

    let query = supabaseAdmin.from('profiles')
      .select('id, full_name, active, xero_employee_id, ordinary_rate, rate_1_5x, rate_2x, rate_2_5x');
    query = body.all ? query.eq('active', true).not('xero_employee_id', 'is', null) : query.eq('id', body.profileId);
    const { data: profiles, error } = await query;
    if (error) throw error;
    if (!profiles?.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: body.all ? 'No active staff are linked to Xero yet.' : 'Profile not found' }) };
    }

    const results = [];
    for (const profile of profiles) {
      const name = profile.full_name || profile.id;
      if (!profile.xero_employee_id) { results.push({ name, ok: false, error: 'Not linked to Xero yet (press Link to Xero first).' }); continue; }
      try {
        const { skipped } = await pushOne(supabaseAdmin, profile, settings || {});
        results.push({ name, ok: true, skipped });
      } catch (err) {
        await supabaseAdmin.from('profiles').update({ xero_payroll_error: `Pay rates: ${err.message}` }).eq('id', profile.id);
        results.push({ name, ok: false, error: err.message });
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
