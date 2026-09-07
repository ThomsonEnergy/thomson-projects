// POST /.netlify/functions/get-invoiceable-actuals
// Body: { projectId }
// Pricing roles only - same audience as raising any invoice. A job with
// no quote behind it (proposal_template 'direct_job', see dashboard.html's
// "+ New job (no quote)") has nothing to claim a % of, so this computes
// what it should actually be invoiced for right now: labour at each
// employee's own sell rate for every hour logged against the job (no OT
// banding - a client is billed the same rate per hour regardless of
// whether it happened to be overtime internally, unlike wage cost), and
// materials at received-PO cost marked up by the cost centre's own
// markup%, same relationship a quoted stage's materials use. Runs
// server-side so an individual's pay rate never has to reach the browser
// (same reason as compute-labour-cost.js) - only the derived sell $ and
// safe hours total come back.
// Assumes one cost centre (true for every no-quote job) - the first is
// used if more than one somehow exists.

const { requirePricingRole } = require('./_shared/require-pricing-role');

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
    const { projectId } = JSON.parse(event.body || '{}');
    if (!projectId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId is required' }) };
    }

    const { data: centres } = await supabaseAdmin
      .from('cost_centres')
      .select('id, markup_percent, invoiced_amount')
      .eq('project_id', projectId)
      .order('sort_order')
      .limit(1);
    const centre = (centres || [])[0];
    if (!centre) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This job has no cost centre yet.' }) };
    }

    const { data: entries } = await supabaseAdmin
      .from('time_entries')
      .select('staff_id, clock_in, clock_out')
      .eq('project_id', projectId)
      .not('clock_out', 'is', null);

    const staffIds = [...new Set((entries || []).map(e => e.staff_id))];
    const [{ data: profiles }, { data: tiers }] = await Promise.all([
      staffIds.length ? supabaseAdmin.from('profiles').select('id, rate_tier_id').in('id', staffIds) : Promise.resolve({ data: [] }),
      supabaseAdmin.from('billable_rate_tiers').select('id, sell_rate'),
    ]);
    const sellRateByProfile = {};
    (profiles || []).forEach(p => {
      const tier = (tiers || []).find(t => t.id === p.rate_tier_id);
      sellRateByProfile[p.id] = tier ? Number(tier.sell_rate) : 0;
    });

    let actualHours = 0, actualLabourSell = 0;
    (entries || []).forEach(e => {
      const hours = (new Date(e.clock_out) - new Date(e.clock_in)) / 3600000;
      actualHours += hours;
      actualLabourSell += hours * (sellRateByProfile[e.staff_id] || 0);
    });

    const { data: pos } = await supabaseAdmin.from('purchase_orders').select('id').eq('project_id', projectId);
    const poIds = (pos || []).map(p => p.id);
    const { data: poLines } = poIds.length
      ? await supabaseAdmin.from('purchase_order_line_items').select('quantity, unit_cost').in('po_id', poIds).eq('received', true)
      : { data: [] };
    const materialCost = (poLines || []).reduce((s, li) => s + (Number(li.quantity) || 0) * (Number(li.unit_cost) || 0), 0);
    const markupFactor = 1 + (Number(centre.markup_percent) || 45) / 100;
    const materialSell = materialCost * markupFactor;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        costCentreId: centre.id,
        actualHours: Math.round(actualHours * 100) / 100,
        actualLabourSell: Math.round(actualLabourSell * 100) / 100,
        materialCost: Math.round(materialCost * 100) / 100,
        materialSell: Math.round(materialSell * 100) / 100,
        invoicedAmount: Number(centre.invoiced_amount) || 0,
      }),
    };
  } catch (err) {
    console.error('get-invoiceable-actuals error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
