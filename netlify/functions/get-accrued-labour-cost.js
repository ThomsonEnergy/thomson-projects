// POST /.netlify/functions/get-accrued-labour-cost
// Body: { projectIds: string[] }
// Any active logged-in user (the labour-budget %, shown to every role, is
// derived from this even though the $ figure itself is only ever
// displayed to pricing roles) - see compute-labour-cost.js for why this
// runs server-side at all: it needs every employee's real pay rate to
// compute correctly, and those must never reach a browser directly.
//
// Labour cost returned is wages plus direct overhead (see
// compute-labour-cost.js). Pricing roles also get the company average
// direct/indirect overhead rates per hour, for the estimate side.
//
// Returns only aggregate $/hours per stage and per project - never an
// individual employee's rate or which employee worked how many hours at
// what rate. That stays admin/finance-only, in Settings > Users & Roles.

const { requireActiveUser } = require('./_shared/require-active-user');
const { computeAccruedLabourCost, loadOverheadRates } = require('./_shared/compute-labour-cost');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin, role } = auth;

  try {
    const { projectIds } = JSON.parse(event.body || '{}');
    if (!Array.isArray(projectIds) || !projectIds.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectIds (a non-empty array) is required' }) };
    }

    const rates = await loadOverheadRates(supabaseAdmin);
    const byProject = await computeAccruedLabourCost(supabaseAdmin, projectIds, { rates });
    const isPricing = ['admin', 'finance', 'sales'].includes(role);
    // Other roles get hours and the budget % only: no $ (on a job one person worked alone,
    // cost / hours would give away their pay rate).
    if (!isPricing) {
      Object.values(byProject).forEach((p) => {
        delete p.totalActualLabourCost; delete p.totalActualWages; delete p.totalIndirectOverhead;
        Object.values(p.byCentre || {}).forEach((c) => { delete c.actualLabourCost; delete c.actualWages; delete c.actualIndirectOverhead; });
      });
    }
    const overheadRates = isPricing ? { directRate: rates.directRate, indirectRate: rates.indirectRate } : null;
    return { statusCode: 200, body: JSON.stringify({ ok: true, byProject, overheadRates }) };
  } catch (err) {
    console.error('get-accrued-labour-cost error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
