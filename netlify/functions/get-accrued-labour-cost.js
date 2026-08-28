// POST /.netlify/functions/get-accrued-labour-cost
// Body: { projectIds: string[] }
// Any active logged-in user (the labour-budget %, shown to every role, is
// derived from this even though the $ figure itself is only ever
// displayed to pricing roles) - see compute-labour-cost.js for why this
// runs server-side at all: it needs every employee's real pay rate to
// compute correctly, and those must never reach a browser directly.
//
// Returns only aggregate $/hours per stage and per project - never an
// individual employee's rate or which employee worked how many hours at
// what rate. That stays admin/finance-only, in Settings > Users & Roles.

const { requireActiveUser } = require('./_shared/require-active-user');
const { computeAccruedLabourCost } = require('./_shared/compute-labour-cost');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { projectIds } = JSON.parse(event.body || '{}');
    if (!Array.isArray(projectIds) || !projectIds.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectIds (a non-empty array) is required' }) };
    }

    const byProject = await computeAccruedLabourCost(supabaseAdmin, projectIds);
    return { statusCode: 200, body: JSON.stringify({ ok: true, byProject }) };
  } catch (err) {
    console.error('get-accrued-labour-cost error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
