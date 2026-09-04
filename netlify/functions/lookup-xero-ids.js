// GET /.netlify/functions/lookup-xero-ids
// Admin-only. Fetches the two Xero-side IDs the "Xero connection" panel
// needs - the Job tracking category and the Ordinary Hours earnings
// rate - since Xero's own screens never show the raw IDs its API uses,
// only the human-readable names. Read-only against Xero either way, so
// a wrong guess at the endpoint shape just comes back as an error here,
// nothing gets changed on Xero's side.

const { requireAdmin } = require('./_shared/require-admin');
const { xeroRequest } = require('./_shared/xero-client');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Admin access required' }) };
  }

  const errors = [];
  let trackingCategories = [];
  let earningsRates = [];
  let payrollCalendars = [];

  try {
    const tcResult = await xeroRequest('accounting', 'TrackingCategories');
    trackingCategories = (tcResult.TrackingCategories || []).map(tc => ({
      id: tc.TrackingCategoryID,
      name: tc.Name,
      options: (tc.Options || []).map(o => ({ name: o.Name })),
    }));
  } catch (err) {
    errors.push(`Tracking categories: ${err.message}`);
  }

  try {
    const piResult = await xeroRequest('payroll.au', 'PayItems');
    earningsRates = (piResult.PayItems?.EarningsRates || []).map(er => ({
      id: er.EarningsRateID,
      name: er.Name,
      type: er.EarningsType,
    }));
  } catch (err) {
    errors.push(`Earnings rates: ${err.message}`);
  }

  // An employee can't have timesheets or a pay run without one of these
  // assigned - found the hard way when the first real timesheet push
  // came back "employee doesn't have payrun calendar".
  try {
    const pcResult = await xeroRequest('payroll.au', 'PayrollCalendars');
    payrollCalendars = (pcResult.PayrollCalendars || []).map(pc => ({
      id: pc.PayrollCalendarID,
      name: pc.Name,
      type: pc.CalendarType,
    }));
  } catch (err) {
    errors.push(`Payroll calendars: ${err.message}`);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, trackingCategories, earningsRates, payrollCalendars, errors }) };
};
