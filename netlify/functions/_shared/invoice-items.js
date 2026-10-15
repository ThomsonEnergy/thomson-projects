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

// items: [{ kind: 'material' | 'prebuild', materialId?, prebuildId?, quantity, unitPrice?, description? }]
// Resolves each against Stock / the prebuild library and returns priced rows
// ready for invoice_line_items (minus the invoice/claim ids), plus totals.
// unitPrice, when given, is the sell price ex GST per unit the person typed
// in; a prebuild's override is split across labour / materials in the same
// proportion as its own price.
async function priceInvoiceItems(supabaseAdmin, items, markupPercent) {
  const list = (items || []).filter(i => i && Number(i.quantity) > 0);
  if (!list.length) return { rows: [], labour: 0, material: 0 };

  const materialIds = [...new Set(list.filter(i => i.kind === 'material').map(i => i.materialId).filter(Boolean))];
  const prebuildIds = [...new Set(list.filter(i => i.kind === 'prebuild').map(i => i.prebuildId).filter(Boolean))];
  const [{ data: materials }, { data: prebuilds }] = await Promise.all([
    materialIds.length ? supabaseAdmin.from('materials').select('id, name, cost_price').in('id', materialIds) : Promise.resolve({ data: [] }),
    prebuildIds.length ? supabaseAdmin.from('prebuilds').select('id, name, prebuild_components(*)').in('id', prebuildIds) : Promise.resolve({ data: [] }),
  ]);
  const materialById = Object.fromEntries((materials || []).map(m => [m.id, m]));
  const prebuildById = Object.fromEntries((prebuilds || []).map(p => [p.id, p]));
  const factor = 1 + (Number(markupPercent) || 0) / 100;
  const override = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);

  let labour = 0, material = 0;
  const rows = list.map((item, i) => {
    const qty = Number(item.quantity);
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
// server-side twin of adjustWarehouseStock() in supabase-client.js. The
// trigger on material_stock_by_location keeps materials.quantity_on_hand in
// step. Never goes below zero.
async function adjustWarehouseStockAdmin(supabaseAdmin, materialId, quantityDelta) {
  const { data: wh } = await supabaseAdmin.from('material_stock_by_location').select('id, quantity').eq('material_id', materialId).eq('location_type', 'warehouse').maybeSingle();
  if (wh) {
    await supabaseAdmin.from('material_stock_by_location').update({
      quantity: Math.max(0, Number(wh.quantity) + quantityDelta), updated_at: new Date().toISOString(),
    }).eq('id', wh.id);
  } else {
    await supabaseAdmin.from('material_stock_by_location').insert({
      material_id: materialId, location_type: 'warehouse', quantity: Math.max(0, quantityDelta),
    });
  }
}

module.exports = { priceInvoiceItems, prebuildUnitPrice, adjustWarehouseStockAdmin, r2 };
