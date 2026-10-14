// POST /api/link-employee-to-xero
// Admin/finance-only. Links app staff to their EXISTING Xero Payroll AU
// employee record. It never creates an employee in Xero.
//
// Why: the old push (sync-employee-to-xero.js) created a new employee
// every time it couldn't see a stored EmployeeID, so anyone already in
// Xero got a duplicate, and what it created was always half-done ("Update
// details for STP2") because this app never collects TFN, super or bank
// details. Xero's own "Invite to onboard" also creates its own record, so
// push + invite made two copies of the same person. Now Xero is the only
// place an employee is created (via its onboarding invite), and this app
// just finds that record and stores its EmployeeID, the same column
// push-timesheets-to-xero.js reads.
//
// Body:
//   { action: 'link', profileId, xeroEmployeeId? }
//       Without xeroEmployeeId: match by email, then by full name. One
//       match links it; several come back as `candidates` for an admin to
//       pick; none comes back as `notFound`. With xeroEmployeeId: links
//       that exact record (after checking it exists).
//   { action: 'link_all' }
//       Same matching for every active staff member not yet linked. Only
//       unambiguous matches are linked; the rest are reported back.
//   { action: 'send_details', profileId }
//       Updates the linked record's date of birth and home address from
//       the app's onboarding details. Sends EmployeeID, so it can only
//       ever update, never create. Nothing else is sent: no tax, bank,
//       super, pay calendar or start date, so nothing the employee or
//       bookkeeper set up in Xero gets overwritten.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Payroll AU 1.0 pages Employees 100 at a time.
async function fetchAllXeroEmployees() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const res = await xeroRequest('payroll.au', `Employees?page=${page}`);
    const batch = res?.Employees || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Just enough for an admin to tell duplicates apart. A record with a pay
// calendar is the "complete" one; a half-created one has none.
function describe(e) {
  return {
    xeroEmployeeId: e.EmployeeID,
    name: [e.FirstName, e.LastName].filter(Boolean).join(' '),
    email: e.Email || '',
    status: e.Status || '',
    hasPayCalendar: !!e.PayrollCalendarID,
  };
}

function findMatches(profile, email, xeroEmployees, takenIds) {
  const pool = xeroEmployees.filter(e => !takenIds.has(e.EmployeeID));
  // Prefer current employees; only fall back to terminated ones if no
  // current record matches at all.
  const tiers = [pool.filter(e => e.Status !== 'TERMINATED'), pool];
  for (const tier of tiers) {
    if (email) {
      const byEmail = tier.filter(e => norm(e.Email) === norm(email));
      if (byEmail.length) return byEmail;
    }
    if (profile.full_name) {
      const byName = tier.filter(e => norm(`${e.FirstName} ${e.LastName}`) === norm(profile.full_name));
      if (byName.length) return byName;
    }
  }
  return [];
}

async function storeLink(supabaseAdmin, profileId, xeroEmployeeId) {
  const { error } = await supabaseAdmin.from('profiles').update({
    xero_employee_id: xeroEmployeeId, xero_payroll_status: 'synced', xero_payroll_error: null,
  }).eq('id', profileId);
  if (error) throw error;
}

const NOT_FOUND_HELP = "Not found in Xero Payroll. Add them in Xero with New employee > Invite to onboard (that collects their TFN, super and bank details), then press Link to Xero again once they've finished.";

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
  const { action, profileId, xeroEmployeeId } = body;

  try {
    // Emails live on auth.users, not profiles.
    const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const emailById = Object.fromEntries((usersPage?.users || []).map(u => [u.id, u.email || '']));

    const { data: profiles, error: profilesErr } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, active, xero_employee_id, date_of_birth, residential_address, residential_suburb, residential_state, residential_postcode');
    if (profilesErr) throw profilesErr;
    const takenIds = new Set(profiles.map(p => p.xero_employee_id).filter(Boolean));

    if (action === 'link') {
      const profile = profiles.find(p => p.id === profileId);
      if (!profile) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Profile not found' }) };

      if (xeroEmployeeId) {
        if (takenIds.has(xeroEmployeeId) && profile.xero_employee_id !== xeroEmployeeId) {
          return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'That Xero employee is already linked to someone else in the app.' }) };
        }
        const check = await xeroRequest('payroll.au', `Employees/${xeroEmployeeId}`);
        if (!check?.Employees?.[0]) throw new Error('That Xero employee could not be found.');
        await storeLink(supabaseAdmin, profileId, xeroEmployeeId);
        return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'linked', employee: describe(check.Employees[0]) }) };
      }

      const xeroEmployees = await fetchAllXeroEmployees();
      const matches = findMatches(profile, emailById[profileId], xeroEmployees, takenIds);
      if (matches.length === 1) {
        await storeLink(supabaseAdmin, profileId, matches[0].EmployeeID);
        return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'linked', employee: describe(matches[0]) }) };
      }
      if (matches.length > 1) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'choose', candidates: matches.map(describe) }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'not_found', message: NOT_FOUND_HELP }) };
    }

    if (action === 'link_all') {
      const xeroEmployees = await fetchAllXeroEmployees();
      const result = { linked: [], ambiguous: [], notFound: [] };
      for (const profile of profiles.filter(p => p.active && !p.xero_employee_id)) {
        const label = profile.full_name || emailById[profile.id] || profile.id;
        const matches = findMatches(profile, emailById[profile.id], xeroEmployees, takenIds);
        if (matches.length === 1) {
          await storeLink(supabaseAdmin, profile.id, matches[0].EmployeeID);
          takenIds.add(matches[0].EmployeeID);
          result.linked.push(label);
        } else if (matches.length > 1) {
          result.ambiguous.push(label);
        } else {
          result.notFound.push(label);
        }
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    }

    if (action === 'send_details') {
      const profile = profiles.find(p => p.id === profileId);
      if (!profile) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Profile not found' }) };
      if (!profile.xero_employee_id) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Link this person to Xero first.' }) };
      }

      const current = (await xeroRequest('payroll.au', `Employees/${profile.xero_employee_id}`))?.Employees?.[0];
      if (!current) throw new Error('The linked Xero employee could not be found. Clear the Xero Employee ID and link again.');

      const fullAddress = profile.residential_address && profile.residential_suburb && profile.residential_state && profile.residential_postcode;
      // Name always comes from Xero's own record, so this can't rename anyone.
      // City/Region/PostalCode, not Suburb/State/Postcode: Xero's Address
      // type is shared platform-wide and rejects the AU field names.
      const update = [{
        EmployeeID: profile.xero_employee_id,
        FirstName: current.FirstName,
        LastName: current.LastName,
        DateOfBirth: profile.date_of_birth || current.DateOfBirth || undefined,
        HomeAddress: fullAddress ? {
          AddressLine1: profile.residential_address,
          City: profile.residential_suburb,
          Region: profile.residential_state,
          PostalCode: profile.residential_postcode,
        } : current.HomeAddress || undefined,
      }];

      try {
        await xeroRequest('payroll.au', 'Employees', { method: 'POST', body: update });
      } catch (xeroErr) {
        await supabaseAdmin.from('profiles').update({ xero_payroll_error: xeroErr.message }).eq('id', profileId);
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: xeroErr.message }) };
      }
      await supabaseAdmin.from('profiles').update({ xero_payroll_error: null }).eq('id', profileId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'updated' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
