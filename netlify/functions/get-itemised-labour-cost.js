// POST /.netlify/functions/get-itemised-labour-cost
// Body: { projectId }
// Admin/Finance only - narrower than the pricing-role gate used for
// aggregate cost figures elsewhere. Returns cost per individual
// time_entries row (used by the job page's timesheet drilldown), which
// is functionally the same thing as revealing that employee's pay rate
// for that shift (cost ÷ hours = their rate) - not appropriate for Sales,
// who can otherwise see aggregate $ figures fine.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { computeEntryLabourCosts } = require('./_shared/compute-labour-cost');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { projectId } = JSON.parse(event.body || '{}');
    if (!projectId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId is required' }) };
    }

    const { data: timeEntries, error } = await supabaseAdmin
      .from('time_entries')
      .select('id, staff_id, clock_in, clock_out')
      .eq('project_id', projectId)
      .not('clock_out', 'is', null);
    if (error) throw error;

    const costById = await computeEntryLabourCosts(supabaseAdmin, timeEntries || []);
    const costByEntryId = Object.fromEntries(costById);

    return { statusCode: 200, body: JSON.stringify({ ok: true, costByEntryId }) };
  } catch (err) {
    console.error('get-itemised-labour-cost error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
