// A fixed-price variation's lines (job_variation_entries.fixed_lines), priced the way a quote stage
// is (backlog item 43, 4 Nov 2026):
//   labour     hours x the rate tier's sell rate (the Schedule of Rates), or a typed rate when no
//              tier is picked (a prebuild's labour component carries its own rate)
//   materials  quantity x cost price x (1 + the variation's markup)
// Priced here, on the server, from the tier's current rate, so the browser cannot send its own figure.
// Lines saved before 4 Nov 2026 have only { description, item_type, amount }: the amount is the sell
// price, quantity 1, markup 0. A prebuild's components share a prebuild_group_id and carry the
// prebuild's client description, which the client's document shows as one line.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function priceFixedLines(supabaseAdmin, rawLines, markupPercent) {
  const markup = r2(markupPercent);
  const { data: tiers, error } = await supabaseAdmin.from('billable_rate_tiers').select('id, name, sell_rate');
  if (error) throw error;
  const tierById = Object.fromEntries((tiers || []).map(t => [t.id, t]));
  return (Array.isArray(rawLines) ? rawLines : []).map((l) => {
    const item_type = l.item_type === 'labour' ? 'labour' : 'material';
    const quantity = r2(l.quantity);
    const tier = item_type === 'labour' && l.rate_tier_id ? tierById[l.rate_tier_id] : null;
    const unit_cost = tier ? r2(tier.sell_rate) : r2(l.unit_cost);
    const description = String(l.description || '').trim().slice(0, 300) || (tier ? tier.name : '');
    const amount = item_type === 'labour' ? r2(quantity * unit_cost) : r2(quantity * unit_cost * (1 + markup / 100));
    return {
      description, item_type, quantity, unit_cost, amount,
      rate_tier_id: tier ? tier.id : null,
      markup_percent: item_type === 'material' ? markup : 0,
      prebuild_group_id: l.prebuild_group_id ? String(l.prebuild_group_id).slice(0, 40) : null,
      prebuild_client_description: l.prebuild_client_description ? String(l.prebuild_client_description).trim().slice(0, 200) : null,
    };
  }).filter(l => l.description && l.quantity > 0 && l.amount > 0);
}

// What the approved variation's stage carries: the lines as line items with the quantity and unit
// cost they were priced at (so the job's Edit stages and costing read like a quoted stage), and the
// stage figures: labour sell, materials at cost, the markup, and the total the client agreed to.
function stageFromFixedLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const rows = list.map((l, i) => ({
    description: l.description, item_type: l.item_type === 'labour' ? 'labour' : 'material',
    quantity: l.quantity != null ? Number(l.quantity) || 1 : 1,
    unit_cost: l.unit_cost != null ? Number(l.unit_cost) || 0 : Number(l.amount) || 0,
    rate_tier_id: l.rate_tier_id || null,
    prebuild_group_id: l.prebuild_group_id || null,
    prebuild_client_description: l.prebuild_client_description || null,
    sort_order: i,
  }));
  const labour = r2(list.filter(l => l.item_type === 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const material = r2(list.filter(l => l.item_type !== 'labour').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const materialCost = r2(rows.filter(r => r.item_type === 'material').reduce((s, r) => s + r.quantity * r.unit_cost, 0));
  const priced = list.find(l => l.item_type !== 'labour' && l.markup_percent != null);
  const markup = priced ? r2(priced.markup_percent) : 0;
  return { rows, labour, material, materialCost, markup, total: r2(labour + material) };
}

module.exports = { priceFixedLines, stageFromFixedLines, r2 };
