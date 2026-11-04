// Stock materials and prebuilds added straight onto an invoice while it's
// being built (do-and-charge jobs, see openInvoiceActualCostsPanel in
// project.html). Shared by create-invoice.js (prices them, takes Stock out
// of the warehouse, records invoice_line_items) and get-invoiceable-actuals.js
// (default prices for the builder), so the price shown while building is the
// price that gets charged unless someone types over it.
//
// Pricing follows do-and-charge variations (variation-lines.js):
//   material   Stock cost price x (1 + the cost centre's markup)
//   prebuild   each component at the prebuild's own price - labour components
//              are sell rates, material components get the markup
// Prebuild components aren't linked to Stock, so a prebuild never moves stock.

const { rateAt } = require('./rate-cards');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One unit of a prebuild: { labour, material, materialCost } (sell labour,
// sell materials, and what those materials cost us).
function prebuildUnitPrice(prebuild, markupPercent) {
  const factor = 1 + (Number(markupPercent) || 0) / 100;
  let labour = 0, material = 0, materialCost = 0;
  (prebuild?.prebuild_components || []).forEach((c) => {
    const line = (Number(c.quantity) || 0) * (Number(c.unit_cost) || 0);
    if (c.item_type === 'labour') labour += line;
    else { material += line * factor; materialCost += line; }
  });
  return { labour: r2(labour), material: r2(material), materialCost: r2(materialCost) };
}

// items: [{ kind: 'material' | 'prebuild' | 'labour', materialId?, jobMaterialUsageId?, prebuildId?, quantity, unitPrice?, description?,
//           staffId?, rateTierId?, timeEntryIds? }]
// Resolves each against Stock / the prebuild library / the rate tiers and returns priced
// rows ready for invoice_line_items (minus the invoice/claim ids), plus totals.
// unitPrice, when given, is the sell price ex GST per unit the person typed
// in; a prebuild's override is split across labour / materials in the same
// proportion as its own price.
//   labour     hours x $/hr (item 41). The rate defaults to the tier's sell rate; a
//              typed rate wins (Schedule of Rates multipliers come typed from the
//              panel). The "Less" line is quantity 1 at a negative rate; the claim as
//              a whole still cannot go negative (create-invoice.js checks).
// rateFactor: the job's charge rate level (_shared/rate-cards.js), applied to a tier's $/hr.
async function priceInvoiceItems(supabaseAdmin, items, markupPercent, rateFactor = 1) {
  const list = (items || []).filter(i => i && Number(i.quantity) > 0);
  if (!list.length) return { rows: [], labour: 0, material: 0 };

  // Materials already costed to the job (a PO line received to it or a Stock draw, job_material_usage)
  // are billed from that row: its cost, its material, and the row's id on the invoice line so it is
  // not offered again. Nothing moves in Stock for those. create-invoice.js checks the row is on the
  // job and not already billed.
  const usageIds = [...new Set(list.filter(i => i.kind === 'material').map(i => i.jobMaterialUsageId).filter(Boolean))];
  const { data: usageRows } = usageIds.length
    ? await supabaseAdmin.from('job_material_usage').select('id, material_id, unit_cost, purchase_order_line_items(description)').in('id', usageIds)
    : { data: [] };
  const usageById = Object.fromEntries((usageRows || []).map(u => [u.id, u]));
  const materialIds = [...new Set([
    ...list.filter(i => i.kind === 'material' && !i.jobMaterialUsageId).map(i => i.materialId),
    ...(usageRows || []).map(u => u.material_id),
  ].filter(Boolean))];
  const prebuildIds = [...new Set(list.filter(i => i.kind === 'prebuild').map(i => i.prebuildId).filter(Boolean))];
  const tierIds = [...new Set(list.filter(i => i.kind === 'labour').map(i => i.rateTierId).filter(Boolean))];
  const staffIds = [...new Set(list.filter(i => i.kind === 'labour').map(i => i.staffId).filter(Boolean))];
  const [{ data: materials }, { data: prebuilds }, { data: tiers }, { data: staff }] = await Promise.all([
    materialIds.length ? supabaseAdmin.from('materials').select('id, name, cost_price').in('id', materialIds) : Promise.resolve({ data: [] }),
    prebuildIds.length ? supabaseAdmin.from('prebuilds').select('id, name, prebuild_components(*)').in('id', prebuildIds) : Promise.resolve({ data: [] }),
    tierIds.length ? supabaseAdmin.from('billable_rate_tiers').select('id, name, sell_rate').in('id', tierIds) : Promise.resolve({ data: [] }),
    staffIds.length ? supabaseAdmin.from('profiles').select('id').in('id', staffIds) : Promise.resolve({ data: [] }),
  ]);
  const materialById = Object.fromEntries((materials || []).map(m => [m.id, m]));
  const prebuildById = Object.fromEntries((prebuilds || []).map(p => [p.id, p]));
  const tierById = Object.fromEntries((tiers || []).map(t => [t.id, t]));
  const staffSet = new Set((staff || []).map(s => s.id));
  const factor = 1 + (Number(markupPercent) || 0) / 100;
  const override = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
  const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

  let labour = 0, material = 0;
  const rows = list.map((item, i) => {
    const qty = Number(item.quantity);
    if (item.kind === 'labour') {
      const tier = item.rateTierId ? tierById[item.rateTierId] : null;
      if (item.rateTierId && !tier) throw new Error('A rate tier on this invoice no longer exists.');
      if (item.staffId && !staffSet.has(item.staffId)) throw new Error('A person on this invoice no longer exists.');
      const unitPrice = override(item.unitPrice) ?? (tier ? rateAt(tier.sell_rate, rateFactor) : null);
      if (unitPrice == null) throw new Error('A labour line needs a rate per hour.');
      const labourAmount = r2(qty * unitPrice);
      labour += labourAmount;
      const timeEntryIds = [...new Set((Array.isArray(item.timeEntryIds) ? item.timeEntryIds : []).filter(isUuid))];
      return {
        kind: 'labour', material_id: null, prebuild_id: null,
        staff_id: item.staffId || null, rate_tier_id: tier?.id || null, time_entry_ids: timeEntryIds.length ? timeEntryIds : null,
        description: (item.description || tier?.name || 'Labour').slice(0, 300), quantity: qty,
        unit_cost: 0, unit_price: unitPrice, labour_amount: labourAmount, material_amount: 0, sort_order: i,
      };
    }
    if (item.kind === 'material' && item.jobMaterialUsageId) {
      const u = usageById[item.jobMaterialUsageId];
      if (!u) throw new Error('A material on this invoice is no longer costed to the job.');
      const unitCost = Number(u.unit_cost) || 0;
      const unitPrice = override(item.unitPrice) ?? r2(unitCost * factor);
      const materialAmount = r2(qty * unitPrice);
      material += materialAmount;
      return {
        kind: 'material', material_id: u.material_id || null, prebuild_id: null, job_material_usage_id: u.id,
        description: (item.description || u.purchase_order_line_items?.description || materialById[u.material_id]?.name || 'Material').slice(0, 300), quantity: qty,
        unit_cost: unitCost, unit_price: unitPrice, labour_amount: 0, material_amount: materialAmount, sort_order: i,
      };
    }
    if (item.kind === 'material') {
      const m = materialById[item.materialId];
      if (!m) throw new Error('A Stock material on this invoice no longer exists.');
      const unitCost = Number(m.cost_price) || 0;
      const unitPrice = override(item.unitPrice) ?? r2(unitCost * factor);
      const materialAmount = r2(qty * unitPrice);
      material += materialAmount;
      return {
        kind: 'material', material_id: m.id, prebuild_id: null,
        description: (item.description || m.name || 'Material').slice(0, 300), quantity: qty,
        unit_cost: unitCost, unit_price: unitPrice, labour_amount: 0, material_amount: materialAmount, sort_order: i,
      };
    }
    if (item.kind === 'prebuild') {
      const p = prebuildById[item.prebuildId];
      if (!p) throw new Error('A prebuild on this invoice no longer exists.');
      const unit = prebuildUnitPrice(p, markupPercent);
      const defaultPrice = r2(unit.labour + unit.material);
      const unitPrice = override(item.unitPrice) ?? defaultPrice;
      const total = r2(qty * unitPrice);
      const labourShare = defaultPrice > 0 ? unit.labour / defaultPrice : 0;
      const labourAmount = r2(total * labourShare);
      const materialAmount = r2(total - labourAmount);
      labour += labourAmount;
      material += materialAmount;
      return {
        kind: 'prebuild', material_id: null, prebuild_id: p.id,
        description: (item.description || p.name || 'Prebuild').slice(0, 300), quantity: qty,
        unit_cost: unit.materialCost, unit_price: unitPrice, labour_amount: labourAmount, material_amount: materialAmount, sort_order: i,
      };
    }
    throw new Error(`Unknown invoice item kind "${item.kind}".`);
  });

  return { rows, labour: r2(labour), material: r2(material) };
}

// Takes quantity out of (negative delta) or back into the Warehouse - the
// server-side twin of adjustWarehouseStock() in supabase-client.js. Runs
// through _stock_adjust (migration 20261025000000), which locks the stock row
// and stops at zero, so a receive or count on the same material at the same
// moment can not overwrite it (bug review M29). The trigger on
// material_stock_by_location keeps materials.quantity_on_hand in step.
async function adjustWarehouseStockAdmin(supabaseAdmin, materialId, quantityDelta) {
  const delta = Number(quantityDelta) || 0;
  if (!materialId || !delta) return;
  const { error } = await supabaseAdmin.rpc('_stock_adjust', {
    p_material: materialId, p_loc: 'warehouse', p_vehicle: null, p_delta: delta, p_allow_short: true,
  });
  if (error) throw error;
}

module.exports = { priceInvoiceItems, prebuildUnitPrice, adjustWarehouseStockAdmin, r2 };
