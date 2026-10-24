// POST /.netlify/functions/get-invoiceable-actuals
// Body: { projectId }
// Pricing roles only - same audience as raising any invoice. A job with
// no quote behind it (proposal_template 'direct_job', see dashboard.html's
// "+ New job (no quote)") has nothing to claim a % of, so this computes
// what it should actually be invoiced for right now: labour at each
// employee's own sell rate for every hour logged against the job (no OT
// banding - a client is billed the same rate per hour regardless of
// whether it happened to be overtime internally, unlike wage cost), and
// materials (received POs plus Stock drawn for the job) at cost marked up
// by the cost centre's own markup%, same relationship a quoted stage's
// materials use. Runs server-side so an individual's pay rate never has to
// reach the browser (same reason as compute-labour-cost.js) - only the
// derived sell $ and safe hours total come back.
//
// Worked out per cost centre (a do-and-charge job can be costed to several,
// e.g. a solar disconnect and the reconnect as two site visits): hours go to
// the cost centre they were clocked to, received PO materials to the PO's
// cost centre, and Stock drawn for the job to its job_material_usage cost
// centre. Anything not tied to a cost centre lands on the first one. Stock
// and prebuilds added straight onto an invoice (invoice_line_items) are left
// out of both sides - they were priced and invoiced in one go - so what's
// left to invoice here is only what's accrued outside the invoice builder.
// The top-level fields are the whole job's totals (with the first cost
// centre's id), which is all the warranty close-out panel needs.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { entryHours, entryCentreIds } = require('./_shared/compute-labour-cost');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
      .select('id, name, markup_percent, invoiced_amount, sort_order')
      .eq('project_id', projectId)
      .order('sort_order');
    if (!(centres || []).length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This job has no cost centre yet.' }) };
    }
    const firstId = centres[0].id;
    const centreOf = (id) => (id && centres.some(c => c.id === id) ? id : firstId);

    const [{ data: entries }, { data: pos }, { data: usage }, { data: invItems }, { data: settings }] = await Promise.all([
      supabaseAdmin.from('time_entries').select('staff_id, clock_in, clock_out, break_minutes, cost_centre_id, selected_cost_centre_ids').eq('project_id', projectId).not('clock_out', 'is', null),
      supabaseAdmin.from('purchase_orders').select('id, cost_centre_id').eq('project_id', projectId),
      // every material costed to this job: PO lines received to it (whichever PO they are on, less any moved
      // off) and Stock draws. Lines received to the Warehouse or moved to another job are not here.
      supabaseAdmin.from('job_material_usage').select('id, cost_centre_id, quantity, unit_cost').eq('project_id', projectId),
      supabaseAdmin.from('invoice_line_items').select('cost_centre_id, labour_amount, material_amount, job_material_usage_id, invoices!inner(project_id)').eq('invoices.project_id', projectId),
      supabaseAdmin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle(),
    ]);

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

    const byCentre = Object.fromEntries(centres.map(c => [c.id, { hours: 0, labourSell: 0, materialCost: 0, itemInvoiced: 0 }]));
    (entries || []).forEach(e => {
      // Paid hours (the unpaid break comes off), shared evenly across the stages of a split
      // entry, the same way the job costing reads them.
      const hours = entryHours(e);
      const centreIds = entryCentreIds(e);
      const share = centreIds.length > 1 ? 1 / centreIds.length : 1;
      (centreIds.length ? centreIds : [null]).forEach(cid => {
        const b = byCentre[centreOf(cid)];
        b.hours += hours * share;
        b.labourSell += hours * share * (sellRateByProfile[e.staff_id] || 0);
      });
    });

    const usageOnInvoices = new Set((invItems || []).map(i => i.job_material_usage_id).filter(Boolean));
    (usage || []).filter(u => !usageOnInvoices.has(u.id)).forEach(u => {
      byCentre[centreOf(u.cost_centre_id)].materialCost += (Number(u.quantity) || 0) * (Number(u.unit_cost) || 0);
    });
    (invItems || []).forEach(i => {
      byCentre[centreOf(i.cost_centre_id)].itemInvoiced += (Number(i.labour_amount) || 0) + (Number(i.material_amount) || 0);
    });

    const defaultMarkup = Number(settings?.default_markup_percent) || 45;
    const centreRows = centres.map(c => {
      const b = byCentre[c.id];
      const markupPercent = c.markup_percent != null ? Number(c.markup_percent) : defaultMarkup;
      return {
        costCentreId: c.id,
        name: c.name,
        markupPercent,
        actualHours: r2(b.hours),
        actualLabourSell: r2(b.labourSell),
        materialCost: r2(b.materialCost),
        materialSell: r2(b.materialCost * (1 + markupPercent / 100)),
        // Invoiced against what's accrued here - builder-added items excluded (see above).
        invoicedAmount: r2(Math.max(0, (Number(c.invoiced_amount) || 0) - b.itemInvoiced)),
      };
    });
    const sum = (k) => r2(centreRows.reduce((s, c) => s + c[k], 0));

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        costCentreId: firstId,
        actualHours: sum('actualHours'),
        actualLabourSell: sum('actualLabourSell'),
        materialCost: sum('materialCost'),
        materialSell: sum('materialSell'),
        invoicedAmount: sum('invoicedAmount'),
        centres: centreRows,
      }),
    };
  } catch (err) {
    console.error('get-invoiceable-actuals error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
