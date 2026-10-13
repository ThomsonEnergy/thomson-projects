// Works out what a job's "do and charge" variations are worth, line by line -
// shared by price-variations.js (the preview in the invoice panel) and
// bill-variations.js (which prices the variation's stage and returns the claim),
// so the two always agree.
//
// A do-and-charge variation has its own cost centre from the moment it is logged,
// which is what the team picks when clocking in. What gets billed:
//   labour     the hours clocked on that stage (time_entries) plus any hours logged
//              by hand on the Variations tab, each at that person's own sell rate
//              (their rate tier)
//   materials  Stock cost price x (1 + the stage markup), like a quoted stage
//   prebuilds  each component at the prebuild's own price (labour components are
//              sell rates, material components get the markup)
// No prices are stored with those rows - they are worked out here, at billing time,
// and server side because a person's rate tier sits on their profile.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function loadVariationLines(supabaseAdmin, projectId, { ids = null } = {}) {
  const { data: settings } = await supabaseAdmin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle();
  const defaultMarkup = Number(settings?.default_markup_percent) || 45;

  let q = supabaseAdmin
    .from('job_variation_entries')
    .select('id, description, hours, work_date, status, created_by, cost_centre_id, variation_number')
    .eq('project_id', projectId)
    .eq('status', 'to_bill')
    .eq('variation_type', 'do_and_charge')
    .order('work_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (ids) q = q.in('id', ids);
  const { data: entries, error: entErr } = await q;
  if (entErr) throw entErr;
  if (!entries || !entries.length) return { defaultMarkup, variations: [] };
  const entryIds = entries.map(e => e.id);
  const centreIds = entries.map(e => e.cost_centre_id).filter(Boolean);

  const [{ data: hourRows }, { data: matRows }, { data: clockRows }, { data: centres }] = await Promise.all([
    supabaseAdmin.from('job_variation_hours').select('variation_id, staff_id, hours').in('variation_id', entryIds),
    supabaseAdmin.from('job_variation_materials').select('*').in('variation_id', entryIds).order('created_at', { ascending: true }),
    centreIds.length
      ? supabaseAdmin.from('time_entries').select('staff_id, cost_centre_id, clock_in, clock_out').in('cost_centre_id', centreIds).not('clock_out', 'is', null)
      : Promise.resolve({ data: [] }),
    centreIds.length
      ? supabaseAdmin.from('cost_centres').select('id, quoted_amount').in('id', centreIds)
      : Promise.resolve({ data: [] }),
  ]);
  const centreById = Object.fromEntries((centres || []).map(c => [c.id, c]));

  const staffIds = [...new Set([
    ...(hourRows || []).map(h => h.staff_id), ...(clockRows || []).map(t => t.staff_id), ...entries.map(e => e.created_by),
  ].filter(Boolean))];
  const materialIds = [...new Set((matRows || []).map(m => m.material_id).filter(Boolean))];
  const prebuildIds = [...new Set((matRows || []).map(m => m.prebuild_id).filter(Boolean))];

  const [{ data: profiles }, { data: tiers }, { data: materials }, { data: prebuilds }] = await Promise.all([
    staffIds.length ? supabaseAdmin.from('profiles').select('id, full_name, rate_tier_id').in('id', staffIds) : Promise.resolve({ data: [] }),
    supabaseAdmin.from('billable_rate_tiers').select('id, sell_rate'),
    materialIds.length ? supabaseAdmin.from('materials').select('id, name, cost_price').in('id', materialIds) : Promise.resolve({ data: [] }),
    prebuildIds.length ? supabaseAdmin.from('prebuilds').select('id, name, prebuild_components(*)').in('id', prebuildIds) : Promise.resolve({ data: [] }),
  ]);

  const profileById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  const sellRateOf = (staffId) => {
    const tier = (tiers || []).find(t => t.id === profileById[staffId]?.rate_tier_id);
    return tier ? Number(tier.sell_rate) : null;
  };
  const materialById = Object.fromEntries((materials || []).map(m => [m.id, m]));
  const prebuildById = Object.fromEntries((prebuilds || []).map(p => [p.id, p]));

  const variations = entries.map((e) => {
    const lines = [];

    // Hours per person: clocked on the stage + logged by hand.
    const hoursByStaff = {};
    (clockRows || []).filter(t => t.cost_centre_id === e.cost_centre_id).forEach((t) => {
      const k = t.staff_id || 'unknown';
      hoursByStaff[k] = (hoursByStaff[k] || 0) + (new Date(t.clock_out) - new Date(t.clock_in)) / 3600000;
    });
    (hourRows || []).filter(h => h.variation_id === e.id).forEach((h) => {
      const k = h.staff_id || 'unknown';
      hoursByStaff[k] = (hoursByStaff[k] || 0) + Number(h.hours);
    });
    const staffKeys = Object.keys(hoursByStaff).filter(k => hoursByStaff[k] > 0);
    staffKeys.forEach((k) => {
      lines.push({
        key: `staff:${k}`, itemType: 'labour', source: 'hours',
        description: `Labour - ${profileById[k]?.full_name || 'Staff member'}`,
        quantity: r2(hoursByStaff[k]), unitCost: k === 'unknown' ? null : sellRateOf(k),
      });
    });
    // Older entries only have the single hours figure typed in when they were logged.
    if (!staffKeys.length && Number(e.hours) > 0) {
      lines.push({
        key: 'legacy', itemType: 'labour', source: 'hours',
        description: `Labour - ${profileById[e.created_by]?.full_name || 'Staff member'}`,
        quantity: r2(e.hours), unitCost: sellRateOf(e.created_by),
      });
    }

    (matRows || []).filter(m => m.variation_id === e.id).forEach((m) => {
      const qty = Number(m.quantity) || 0;
      if (m.kind === 'material') {
        const mat = materialById[m.material_id];
        lines.push({
          key: `mat:${m.id}`, itemType: 'material', source: 'material', materialId: m.material_id || null,
          description: m.description || mat?.name || 'Material', quantity: qty,
          unitCost: mat && mat.cost_price != null ? Number(mat.cost_price) : null,
        });
      } else if (m.kind === 'other') {
        lines.push({
          key: `mat:${m.id}`, itemType: 'material', source: 'other',
          description: m.description, quantity: qty,
          unitCost: m.other_unit_cost != null ? Number(m.other_unit_cost) : null,
        });
      } else if (m.kind === 'prebuild') {
        const pb = prebuildById[m.prebuild_id];
        const comps = (pb?.prebuild_components || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        if (!comps.length) {
          lines.push({
            key: `mat:${m.id}`, itemType: 'material', source: 'prebuild',
            description: m.description, quantity: qty, unitCost: null,
          });
        }
        comps.forEach((c) => {
          lines.push({
            key: `pb:${m.id}:${c.id}`, itemType: c.item_type === 'labour' ? 'labour' : 'material', source: 'prebuild',
            description: `${pb.name} - ${c.description}`,
            quantity: r2((Number(c.quantity) || 0) * qty), unitCost: Number(c.unit_cost) || 0,
          });
        });
      }
    });

    const centre = centreById[e.cost_centre_id];
    return {
      id: e.id, description: e.description, workDate: e.work_date, number: e.variation_number,
      costCentreId: e.cost_centre_id || null,
      // Already priced onto its stage (an earlier attempt priced it but the invoice didn't get made).
      priced: !!centre && Number(centre.quoted_amount) > 0,
      lines,
    };
  });

  return { defaultMarkup, variations };
}

// overrides: { [line key]: unit cost / rate typed in by the person billing }.
function computeTotals(lines, overrides = {}, markupPercent = 45) {
  const factor = 1 + (Number(markupPercent) || 0) / 100;
  let labour = 0, material = 0, materialCost = 0;
  const missing = [];
  lines.forEach((l) => {
    const raw = overrides[l.key] != null && overrides[l.key] !== '' ? Number(overrides[l.key]) : l.unitCost;
    if (raw == null || Number.isNaN(raw)) { missing.push(l); return; }
    if (l.itemType === 'labour') labour += r2(l.quantity * raw);
    else { material += r2(l.quantity * raw * factor); materialCost += r2(l.quantity * raw); }
  });
  return { labour: r2(labour), material: r2(material), materialCost: r2(materialCost), total: r2(labour + material), missing };
}

module.exports = { loadVariationLines, computeTotals, r2 };
