// POST /.netlify/functions/get-invoiceable-actuals
// Body: { projectId }
// Pricing roles only - same audience as raising any invoice. A job with
// no quote behind it (proposal_template 'direct_job', see dashboard.html's
// "+ New job (no quote)") has nothing to claim a % of, so this computes
// what it should actually be invoiced for right now: labour at each
// employee's own sell rate for every hour logged against the job, and
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
//
// Labour (item 41): each cost centre also gets labourLines, one per clocked
// shift not yet on an invoice (labour line items record the shifts they
// billed in time_entry_ids): who, their rate tier and $/hr, the date, start
// and finish, and the hours split into Schedule of Rates bands
// (_shared/labour-bands.js). The panel builds the rows from these either
// "as per Schedule of Rates" (multipliers, 2 hour minimum) or flat.
// The top-level fields are the whole job's totals (with the first cost
// centre's id), which is all the warranty close-out panel needs.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { entryHours, entryCentreIds } = require('./_shared/compute-labour-cost');
const { shiftBands, RULES } = require('./_shared/labour-bands');

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

    const [{ data: entries }, { data: usage }, { data: invItems }, { data: settings }, { data: holidays }, { data: tiers }] = await Promise.all([
      supabaseAdmin.from('time_entries').select('id, staff_id, clock_in, clock_out, break_minutes, cost_centre_id, selected_cost_centre_ids').eq('project_id', projectId).not('clock_out', 'is', null).order('clock_in'),
      // every material costed to this job: PO lines received to it (whichever PO they are on, less any moved
      // off) and Stock draws. Lines received to the Warehouse or moved to another job are not here.
      supabaseAdmin.from('job_material_usage').select('id, cost_centre_id, quantity, unit_cost').eq('project_id', projectId),
      supabaseAdmin.from('invoice_line_items').select('cost_centre_id, kind, labour_amount, material_amount, job_material_usage_id, time_entry_ids, invoices!inner(project_id)').eq('invoices.project_id', projectId),
      supabaseAdmin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle(),
      supabaseAdmin.from('public_holidays').select('holiday_date'),
      supabaseAdmin.from('billable_rate_tiers').select('id, name, sell_rate').order('sort_order'),
    ]);

    const staffIds = [...new Set((entries || []).map(e => e.staff_id))];
    const { data: profiles } = staffIds.length
      ? await supabaseAdmin.from('profiles').select('id, full_name, rate_tier_id').in('id', staffIds)
      : { data: [] };
    const tierById = Object.fromEntries((tiers || []).map(t => [t.id, t]));
    const profileById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
    const sellRateByProfile = {};
    (profiles || []).forEach(p => {
      const tier = tierById[p.rate_tier_id];
      sellRateByProfile[p.id] = tier ? Number(tier.sell_rate) : 0;
    });
    const holidaySet = new Set((holidays || []).map(h => h.holiday_date));
    const billedEntries = new Set((invItems || []).flatMap(i => i.time_entry_ids || []));

    const byCentre = Object.fromEntries(centres.map(c => [c.id, { hours: 0, labourSell: 0, materialCost: 0, itemInvoiced: 0, labourLines: [] }]));
    (entries || []).forEach(e => {
      // Paid hours (the unpaid break comes off), shared evenly across the stages of a split
      // entry, the same way the job costing reads them.
      const hours = entryHours(e);
      const centreIds = entryCentreIds(e);
      const share = centreIds.length > 1 ? 1 / centreIds.length : 1;
      const rate = sellRateByProfile[e.staff_id] || 0;
      const profile = profileById[e.staff_id] || {};
      const shift = billedEntries.has(e.id) ? null : shiftBands(e, holidaySet);
      (centreIds.length ? centreIds : [null]).forEach(cid => {
        const b = byCentre[centreOf(cid)];
        b.hours += hours * share;
        b.labourSell += hours * share * rate;
        if (!shift) return;
        const bands = {};
        Object.entries(shift.bands).forEach(([band, h]) => { bands[band] = r2(h * share); });
        b.labourLines.push({
          timeEntryId: e.id,
          staffId: e.staff_id,
          staffName: profile.full_name || 'Staff',
          rateTierId: profile.rate_tier_id || null,
          tierName: tierById[profile.rate_tier_id]?.name || '',
          rate,
          dateKey: shift.dateKey,
          start: shift.start,
          end: shift.end,
          hours: r2(hours * share),
          bands,
        });
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
        // Invoiced against what's accrued here - builder-added items (labour lines included) excluded (see above).
        invoicedAmount: r2(Math.max(0, (Number(c.invoiced_amount) || 0) - b.itemInvoiced)),
        labourLines: b.labourLines,
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
        rateTiers: (tiers || []).map(t => ({ id: t.id, name: t.name, sellRate: Number(t.sell_rate) || 0 })),
        rules: RULES,
      }),
    };
  } catch (err) {
    console.error('get-invoiceable-actuals error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
