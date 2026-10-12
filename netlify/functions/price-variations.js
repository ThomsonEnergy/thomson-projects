// POST /.netlify/functions/price-variations
// Body: { projectId }
// Pricing roles only. What each logged variation that is still "to bill" is
// worth right now (labour at each person's sell rate, Stock materials at cost
// plus the stage markup, prebuilds at their own price), so the invoice panel
// can show it before anything is created. Nothing is written here - see
// bill-variations.js for that. A variation that has already been turned into a
// stage (but whose invoice didn't get made) isn't listed: it already shows
// up as a normal stage with a balance to claim.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { loadVariationLines, computeTotals } = require('./_shared/variation-lines');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin } = auth;

  try {
    const { projectId } = JSON.parse(event.body || '{}');
    if (!projectId) return { statusCode: 400, body: JSON.stringify({ error: 'projectId is required' }) };

    const { defaultMarkup, variations } = await loadVariationLines(supabaseAdmin, projectId);
    const out = variations
      .filter(v => !v.costCentreId)
      .map((v) => {
        const t = computeTotals(v.lines, {}, defaultMarkup);
        return {
          id: v.id, description: v.description, workDate: v.workDate,
          lines: v.lines.map(l => ({ key: l.key, itemType: l.itemType, source: l.source, description: l.description, quantity: l.quantity, unitCost: l.unitCost })),
          totals: { labour: t.labour, material: t.material, total: t.total },
        };
      });

    return { statusCode: 200, body: JSON.stringify({ ok: true, defaultMarkup, variations: out }) };
  } catch (err) {
    console.error('price-variations error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
