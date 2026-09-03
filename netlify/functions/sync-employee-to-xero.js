// POST /api/sync-employee-to-xero
// Body: { profileId }
// Admin/finance-only. Attempts to create this person as an employee in
// Xero Payroll AU via the existing Custom Connection - the same
// connection already used for Timesheets (see push-timesheets-to-xero.js),
// but employee CREATION additionally needs the payroll.employees scope,
// which this app's Xero Custom Connection app may not have been granted
// yet (see SETUP.md). Field names below are read from Xero's docs, not
// verified against a live response.
//
// On success: stores the returned Xero EmployeeID into the existing
// xero_employee_id column - the same column push-timesheets-to-xero.js
// already reads to match timesheets, so nothing else needs to change.
// On failure: records the error and returns a plain summary of every
// onboarding field collected, for an admin to key into Xero by hand.
// Xero's own bulk-CSV employee import "is deliberately limited to basic
// identity and contact details" (TFN/bank/rates always need manual entry
// regardless of import method) - so a summary is more useful than a CSV.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');

function buildSummary(profile, email) {
  return {
    'Full name': profile.full_name || '',
    'Email': email || '',
    'Date of birth': profile.date_of_birth || '',
    'Residential address': profile.residential_address || '',
    'Tax file number': profile.tax_file_number || '',
    'Employment type': profile.employment_type || '',
    'Start date': profile.employment_start_date || '',
    'Pay type': profile.pay_type || '',
    'Annual salary': profile.annual_salary || '',
    'Ordinary rate ($/hr)': profile.ordinary_rate || '',
    'Bank account name': profile.bank_account_name || '',
    'Bank BSB': profile.bank_bsb || '',
    'Bank account number': profile.bank_account_number || '',
    'Super fund': profile.super_is_self_managed
      ? `Self-managed - ABN ${profile.smsf_abn || ''}, BSB ${profile.smsf_bank_bsb || ''}, Acct ${profile.smsf_bank_account || ''}, ESA ${profile.smsf_esa || ''}`
      : `${profile.super_fund_name || ''} (ABN ${profile.super_fund_abn || ''}, Member ${profile.super_member_number || ''})`,
    'Emergency contact': [profile.emergency_contact_name, profile.emergency_contact_relationship, profile.emergency_contact_phone].filter(Boolean).join(' - '),
  };
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

  let profileId;
  try {
    ({ profileId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid request body' }) };
  }
  if (!profileId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'profileId is required' }) };
  }

  try {
    const { data: profile, error: profileErr } = await supabaseAdmin.from('profiles').select('*').eq('id', profileId).single();
    if (profileErr || !profile) throw new Error('Profile not found');

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(profileId);
    const email = authUser?.user?.email || '';

    const [firstName, ...rest] = (profile.full_name || '').trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName || 'Unknown';

    // Payroll AU's Employees endpoint wants a bare JSON array as the
    // request body (unlike the Accounting API's {"Invoices": [...]}
    // style wrapping) - wrapping it in an {Employees: [...]} object gets
    // rejected as a deserialization error before Xero even looks at the
    // employee fields themselves.
    const employeePayload = [{
      FirstName: firstName || 'Unknown',
      LastName: lastName,
      Email: email || undefined,
      DateOfBirth: profile.date_of_birth || undefined,
      StartDate: profile.employment_start_date || undefined,
      HomeAddress: profile.residential_address ? { AddressLine1: profile.residential_address } : undefined,
      BankAccounts: profile.bank_account_number ? [{
        AccountName: profile.bank_account_name || profile.full_name,
        BSB: profile.bank_bsb,
        AccountNumber: profile.bank_account_number,
        Remainder: true,
      }] : undefined,
      TaxDeclaration: profile.tax_file_number ? { TaxFileNumber: profile.tax_file_number } : undefined,
    }];

    let xeroResult;
    try {
      xeroResult = await xeroRequest('payroll.au', 'Employees', { method: 'POST', body: employeePayload });
    } catch (xeroErr) {
      await supabaseAdmin.from('profiles').update({ xero_payroll_status: 'failed', xero_payroll_error: xeroErr.message }).eq('id', profileId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'failed', error: xeroErr.message, summary: buildSummary(profile, email) }) };
    }

    const newEmployeeId = xeroResult?.Employees?.[0]?.EmployeeID;
    if (!newEmployeeId) {
      const msg = 'Xero accepted the request but did not return an EmployeeID - check the raw response in the function logs.';
      console.error('Unexpected Xero Employees response:', JSON.stringify(xeroResult));
      await supabaseAdmin.from('profiles').update({ xero_payroll_status: 'failed', xero_payroll_error: msg }).eq('id', profileId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'failed', error: msg, summary: buildSummary(profile, email) }) };
    }

    await supabaseAdmin.from('profiles').update({
      xero_employee_id: newEmployeeId, xero_payroll_status: 'synced', xero_payroll_error: null,
    }).eq('id', profileId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'synced', xeroEmployeeId: newEmployeeId }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
