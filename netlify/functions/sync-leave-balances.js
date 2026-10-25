// Scheduled (daily, see netlify.toml) and POST from a finance role: copies each
// linked employee's leave balances from Xero Payroll AU into public.leave_balances,
// so the Staff page can show annual, sick and long service leave without a Xero
// login. Read only on the Xero side: Xero stays the source of truth and the app
// never writes leave back.
//
// Xero only returns LeaveBalances on GET Employees/{EmployeeID} (not on the list),
// so it is one call per person. Each balance has LeaveName, NumberOfUnits and
// TypeOfUnits (Hours or Days). A name with "Long Service" goes to
// long_service_hours, "Annual" to annual_leave_hours, "Sick" or "Personal" to
// sick_leave_hours; Days become hours at 7.6 a day. Other leave types Xero lists
// (time in lieu, unpaid leave) are left out. A type Xero does not list for a
// person stays null (not tracked for them); a listed zero is 0.
//
// Two ways in, one piece of work (syncLeaveBalances):
//   - the daily schedule: no bearer token, logged through the agent log like the
//     other Xero jobs. Netlify does not route HTTP calls to a scheduled function
//     in production (see sync-gmail.js), so nothing but the scheduler reaches
//     this path;
//   - POST with a finance role's bearer token (the Staff page's "Refresh from
//     Xero"). Because of that routing rule the button needs a thin HTTP function
//     that calls syncLeaveBalances() from here, the same split as sync-gmail.js
//     and sync-gmail-now.js.

const { getAdminClient } = require('./_shared/require-admin');
const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');
const { runAgent } = require('./_shared/agent-log');

// A standard full-time day, used when Xero keeps a balance in days.
const HOURS_PER_DAY = 7.6;

function columnFor(leaveName) {
  const name = String(leaveName || '').toLowerCase();
  if (name.includes('long service')) return 'long_service_hours';
  if (name.includes('annual')) return 'annual_leave_hours';
  if (name.includes('sick') || name.includes('personal')) return 'sick_leave_hours';
  return null;
}

const r2 = (n) => Math.round(n * 100) / 100;

// One row per active, Xero-linked profile. A person Xero cannot return is
// reported, not fatal; if nobody could be read at all the whole run fails so
// the agent log shows it (a dead token looks like that).
async function syncLeaveBalances(supabaseAdmin) {
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, xero_employee_id')
    .eq('active', true)
    .not('xero_employee_id', 'is', null);
  if (error) throw new Error(error.message);

  const asAt = new Date().toISOString();
  const rows = [];
  const problems = [];
  // One person at a time: each call fetches its own token, and Xero's limit is
  // 60 calls a minute per organisation.
  for (const p of profiles || []) {
    try {
      const employee = (await xeroRequest('payroll.au', `Employees/${encodeURIComponent(p.xero_employee_id)}`))?.Employees?.[0];
      if (!employee) throw new Error('not found in Xero Payroll');
      const row = { profile_id: p.id, annual_leave_hours: null, sick_leave_hours: null, long_service_hours: null, as_at: asAt, synced_at: asAt };
      (employee.LeaveBalances || []).forEach(b => {
        const column = columnFor(b.LeaveName);
        if (!column) return;
        const units = Number(b.NumberOfUnits) || 0;
        const hours = String(b.TypeOfUnits || '').toLowerCase() === 'days' ? units * HOURS_PER_DAY : units;
        row[column] = r2((row[column] || 0) + hours);
      });
      rows.push(row);
    } catch (err) {
      problems.push(`${p.full_name || p.id}: ${err.message}`);
    }
  }

  if (rows.length) {
    const { error: upErr } = await supabaseAdmin.from('leave_balances').upsert(rows, { onConflict: 'profile_id' });
    if (upErr) throw new Error(upErr.message);
  } else if (problems.length) {
    throw new Error(`No leave balances could be read from Xero (${problems[0]})`);
  }
  return { synced: rows.length, total: (profiles || []).length, problems };
}

exports.handler = async (event) => {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';

  // Refresh from Xero on the Staff page: finance roles only.
  if (authHeader) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    const auth = await requireFinanceRole(event);
    if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
    try {
      const result = await syncLeaveBalances(auth.supabaseAdmin);
      return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
      console.error('sync-leave-balances failed:', err.message);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  // The daily scheduled run. Reports to the ops manager (_shared/agent-log.js).
  return runAgent('sync-leave-balances', async () => {
    const result = await syncLeaveBalances(getAdminClient());
    return {
      quiet: !result.total,
      summary: `Leave balances refreshed from Xero for ${result.synced} of ${result.total} people${result.problems.length ? `, ${result.problems.length} could not be read` : ''}`,
      details: result,
      needsMe: result.problems.length,
      response: { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) },
    };
  });
};

exports.syncLeaveBalances = syncLeaveBalances;
