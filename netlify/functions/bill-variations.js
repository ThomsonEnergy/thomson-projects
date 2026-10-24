// POST /.netlify/functions/bill-variations
// Body: { projectId, items: [{ id, markupPercent?, overrides?: { [line key]: unit cost / rate } }] }
// Pricing roles only. Prices each chosen do-and-charge variation onto its own
// stage (cost centre, created when the variation was logged - it is what the team
// clocks time to): the clocked hours (a split entry's share included, the unpaid
// break taken off, see _shared/variation-lines.js), the logged hours, Stock
// materials and prebuild items become that stage's line items and its quoted amount. Returns the claim to
// put on an invoice for it. Because it is a stage, the invoice, the client's
// invoice page, balance due and the Xero push all work for a variation exactly as
// they do for any quoted stage. The stage never appears on the client's quote
// (only approved fixed-price variations do).
//
// Safe to repeat: a variation already priced (an earlier attempt priced it but the
// invoice didn't get created) returns what is left to claim on its stage instead of
// pricing it again. The variation itself is only marked billed by create-invoice.js,
// once the invoice exists.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { loadVariationLines, computeTotals, r2 } = require('./_shared/variation-lines');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin, user } = auth;

  try {
    const { projectId, items } = JSON.parse(event.body || '{}');
    if (!projectId || !Array.isArray(items) || !items.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId and at least one variation are required' }) };
    }

    const ids = items.map(i => i.id);
    const { defaultMarkup, variations } = await loadVariationLines(supabaseAdmin, projectId, { ids });
    const byId = Object.fromEntries(variations.map(v => [v.id, v]));

    const claims = [];
    for (const item of items) {
      const v = byId[item.id];
      if (!v) throw new Error('A selected variation was not found, is not a do-and-charge variation, or has already been billed.');

      // Already priced by an earlier attempt: hand back what is left to claim.
      if (v.priced) {
        const { data: centre } = await supabaseAdmin.from('cost_centres').select('id, quoted_amount, estimated_labour_cost, invoiced_amount').eq('id', v.costCentreId).single();
        const remaining = r2((Number(centre.quoted_amount) || 0) - (Number(centre.invoiced_amount) || 0));
        if (remaining > 0.004) {
          const labour = Math.min(r2(Number(centre.estimated_labour_cost) || 0), remaining);
          claims.push({ variationId: v.id, costCentreId: centre.id, labourAmount: labour, materialAmount: r2(remaining - labour), claimPercent: 100 });
        }
        continue;
      }

      const markup = item.markupPercent != null && item.markupPercent !== '' ? Number(item.markupPercent) : defaultMarkup;
      const totals = computeTotals(v.lines, item.overrides || {}, markup);
      if (totals.missing.length) {
        throw new Error(`"${v.description}": set a price for ${totals.missing.map(l => l.description).join(', ')}.`);
      }
      if (totals.total <= 0) {
        throw new Error(`"${v.description}" has nothing to bill yet - clock time to it or add hours / materials first (or mark it No charge).`);
      }

      // Its stage normally exists already; make one if an older entry somehow has none.
      let centreId = v.costCentreId;
      if (!centreId) {
        const { data: last } = await supabaseAdmin.from('cost_centres').select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1);
        const nextSort = ((last || [])[0]?.sort_order ?? -1) + 1;
        const { data: created, error: ccErr } = await supabaseAdmin.from('cost_centres').insert({
          project_id: projectId, name: `Variation ${v.number || ''}: ${v.description}`.slice(0, 90), sort_order: nextSort,
          description: `Out-of-scope work logged ${v.workDate}`, variation_entry_id: v.id,
        }).select('id').single();
        if (ccErr) throw ccErr;
        centreId = created.id;
        await supabaseAdmin.from('job_variation_entries').update({ cost_centre_id: centreId }).eq('id', v.id);
      }

      const { error: ccUpErr } = await supabaseAdmin.from('cost_centres').update({
        estimated_labour_cost: totals.labour,
        estimated_material_cost: totals.materialCost,
        markup_percent: markup,
        quoted_amount: totals.total,
      }).eq('id', centreId);
      if (ccUpErr) throw ccUpErr;

      await supabaseAdmin.from('cost_centre_line_items').delete().eq('cost_centre_id', centreId);
      const ordered = [...v.lines.filter(l => l.itemType === 'labour'), ...v.lines.filter(l => l.itemType !== 'labour')];
      const o = item.overrides || {};
      const lineRows = ordered.map((l, i) => {
        const unit = o[l.key] != null && o[l.key] !== '' ? Number(o[l.key]) : l.unitCost;
        return { cost_centre_id: centreId, description: l.description, item_type: l.itemType, quantity: l.quantity, unit_cost: unit, sort_order: i };
      });
      const { error: liErr } = await supabaseAdmin.from('cost_centre_line_items').insert(lineRows);
      if (liErr) throw liErr;

      // Stock materials were already taken out of the warehouse when they were added
      // to the variation - record the real cost against the job now, as for any
      // other material drawn from stock.
      const usageRows = v.lines.filter(l => l.source === 'material' && l.materialId).map(l => ({
        project_id: projectId, cost_centre_id: centreId, material_id: l.materialId,
        quantity: l.quantity, unit_cost: l.unitCost ?? 0, source: 'from_stock', created_by: user.id,
      }));
      if (usageRows.length) await supabaseAdmin.from('job_material_usage').insert(usageRows);

      claims.push({ variationId: v.id, costCentreId: centreId, labourAmount: totals.labour, materialAmount: totals.material, claimPercent: 100 });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, claims }) };
  } catch (err) {
    console.error('bill-variations error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
