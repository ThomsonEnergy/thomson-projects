// POST /api/sync-employee-to-xero
// Body: { profileId }
// Admin/finance-only. Attempts to create this person as an employee in
// Xero Payroll AU via the existing Custom Connection - the same
// connection already used for Timesheets (see push-timesheets-to-xero.js).
// Field names below are read from Xero's docs, not verified against a
// live response - the request does reach Xero (auth/scope is fine), so
// a failure here is a payload/validation issue, not a permissions one.
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
const { xeroRequest, redactSensitive } = require('./_shared/xero-client');

const EMPLOYMENT_BASIS = { full_time: 'FULLTIME', part_time: 'PARTTIME', casual: 'CASUAL' };

function buildSummary(profile, email) {
  return {
    'Full name': profile.full_name || '',
    'Email': email || '',
    'Date of birth': profile.date_of_birth || '',
    'Residential address': [profile.residential_address, profile.residential_suburb, profile.residential_state, profile.residential_postcode].filter(Boolean).join(', '),
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

    const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_payroll_calendar_id').eq('id', 1).single();

    const [firstName, ...rest] = (profile.full_name || '').trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName || 'Unknown';

    // Payroll AU's Employees endpoint wants a bare JSON array as the
    // request body (unlike the Accounting API's {"Invoices": [...]}
    // style wrapping) - wrapping it in an {Employees: [...]} object gets
    // rejected as a deserialization error before Xero even looks at the
    // employee fields themselves.
    //
    // Including EmployeeID (when this profile already has one) makes
    // this an UPDATE of the existing Xero record instead of creating a
    // second, duplicate employee - needed the first time this was tried
    // twice in a row to attach a payroll calendar after the fact.
    const employeePayload = [{
      EmployeeID: profile.xero_employee_id || undefined,
      FirstName: firstName || 'Unknown',
      LastName: lastName,
      Email: email || undefined,
      DateOfBirth: profile.date_of_birth || undefined,
      StartDate: profile.employment_start_date || undefined,
      // An employee can't have timesheets or a pay run without one of
      // these assigned - found when the first real timesheet push came
      // back "employee doesn't have payrun calendar".
      PayrollCalendarID: settings?.xero_payroll_calendar_id || undefined,
      // Xero's validation message uses AU-friendly terms ("The Suburb is
      // required") but the actual wire schema is Xero's general Address
      // type, shared across the whole platform - City/Region/PostalCode,
      // not Suburb/State/Postcode. Sending "Suburb" got a second, blunter
      // error back: "Suburb is not a valid element in HomeAddress".
      HomeAddress: profile.residential_address ? {
        AddressLine1: profile.residential_address,
        City: profile.residential_suburb || undefined,
        Region: profile.residential_state || undefined,
        PostalCode: profile.residential_postcode || undefined,
      } : undefined,
      BankAccounts: profile.bank_account_number ? [{
        AccountName: profile.bank_account_name || profile.full_name,
        BSB: profile.bank_bsb,
        AccountNumber: profile.bank_account_number,
        Remainder: true,
        StatementText: 'Wages', // shows on the employee's bank statement for the deposit - required, Xero has no default
      }] : undefined,
      // EmploymentBasis is mandatory for an STP2-qualified employee - Xero
      // rejected the record outright without it ("Invalid EmploymentBasis"),
      // even though TaxFileNumber alone was present.
      TaxDeclaration: profile.tax_file_number ? {
        TaxFileNumber: profile.tax_file_number,
        EmploymentBasis: EMPLOYMENT_BASIS[profile.employment_type] || undefined,
      } : undefined,
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
      console.error('Unexpected Xero Employees response:', JSON.stringify(redactSensitive(xeroResult)));
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
