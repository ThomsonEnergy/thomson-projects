// What a job has actually cost and what it should be invoiced for, per cost centre: the hours
// clocked (at each person's sell rate, split into Schedule of Rates bands) and the materials
// used (PO lines received to the job and Stock draws, at cost and at cost plus the stage's
// markup). The one copy of this maths: get-invoiceable-actuals.js (the do-and-charge invoice
// panel, pricing roles) and the client portal's "Work so far" (portal-read.js) both call it.
// Reads only; an individual's pay rate never leaves the server (same reason as
// compute-labour-cost.js), only the derived sell $ and hours.
//
// jobActuals(admin, projectId, { invoiceId, includeBilled, shared }) -> { ok, data } | { ok: false, error }
//   Throws when a read fails: these are money figures, so a failed read is an error, never a low number.
//   shared: loadActualsShared()'s answer, when one caller reads many jobs (jobs-left-to-invoice.js).
//   invoiceId: edit mode (item 64): that invoice's shifts and materials count as not yet billed
//     and `invoice` carries the row with its claims and line items.
//   includeBilled: shifts and materials already on an invoice come back too, each marked
//     invoiced: true with the invoice's number (the portal shows the whole job, not only what is
//     left to bill). Off by default: the panel only wants what is still to invoice.
// data: { costCentreId, actualHours, actualLabourSell, materialCost, materialSell, invoicedAmount,
//         centres: [{ costCentreId, name, markupPercent, actualHours, actualLabourSell, materialCost,
//           materialSell, invoicedAmount, labourLines, materialLines }], rateTiers, rateCard, rules,
//         invoice, openInvoices }
//
// priceActuals(data) -> { labour, materials, labourOpen, materialsOpen, notInvoiced, agreementOff, lumpInvoiced, leftToInvoice }
//   The same lines at the price a do and charge invoice carries by default (the panel's
//   "As per Schedule of Rates"), so "work not yet invoiced" is one figure everywhere: the
//   portal's Work so far (portal-data.js) and Left to invoice on the Jobs list and the job page
//   (jobs-left-to-invoice.js). No reads.

const { entryHours, entryCentreIds } = require('./compute-labour-cost');
const { shiftBands, RULES } = require('./labour-bands');
const { rateCardFor, rateAt } = require('./rate-cards');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The three lookups every job shares (the default markup, the public holidays, the rate tiers).
async function loadActualsShared(supabaseAdmin) {
  const reads = await Promise.all([
    supabaseAdmin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle(),
    supabaseAdmin.from('public_holidays').select('holiday_date'),
    supabaseAdmin.from('billable_rate_tiers').select('id, name, sell_rate').order('sort_order'),
  ]);
  failOnReadError(reads);
  return { settings: reads[0].data, holidays: reads[1].data, tiers: reads[2].data };
}
function failOnReadError(reads) {
  const failed = reads.find((r) => r && r.error);
  if (failed) throw new Error(`The job's figures could not be read: ${failed.error.message}`);
}

async function jobActuals(supabaseAdmin, projectId, { invoiceId = null, includeBilled = false, shared = null } = {}) {
  let editInvoice = null;
  if (invoiceId) {
    const { data: inv, error: invErr } = await supabaseAdmin.from('invoices')
      .select('id, invoice_number, description, sent_at, due_date, notes, xero_invoice_id, paid_at, invoice_claims(cost_centre_id, labour_amount, material_amount, stc_amount, bstc_amount), invoice_line_items(id, cost_centre_id, kind, material_id, prebuild_id, job_material_usage_id, staff_id, rate_tier_id, time_entry_ids, description, quantity, unit_cost, unit_price, labour_amount, material_amount, sort_order)')
      .eq('id', invoiceId).eq('project_id', projectId).maybeSingle();
    if (invErr) throw invErr;
    if (!inv) return { ok: false, error: 'That invoice is not on this job.' };
    if (inv.xero_invoice_id) return { ok: false, error: 'This invoice is in Xero. Changes go through a credit note.' };
    if (inv.paid_at) return { ok: false, error: 'This invoice is paid and cannot be edited.' };
    editInvoice = inv;
  }

  const centresRead = await supabaseAdmin
    .from('cost_centres')
    .select('id, name, markup_percent, invoiced_amount, sort_order')
    .eq('project_id', projectId)
    .order('sort_order');
  failOnReadError([centresRead]);
  const centres = centresRead.data;
  if (!(centres || []).length) return { ok: false, error: 'This job has no cost centre yet.' };
  const firstId = centres[0].id;
  const centreOf = (id) => (id && centres.some(c => c.id === id) ? id : firstId);

  const [entriesRead, usageRead, invItemsRead, openInvoicesRead, lookups] = await Promise.all([
    supabaseAdmin.from('time_entries').select('id, staff_id, clock_in, clock_out, break_minutes, cost_centre_id, selected_cost_centre_ids, billable').eq('project_id', projectId).not('clock_out', 'is', null).order('clock_in'),
    // every material costed to this job: PO lines received to it (whichever PO they are on, less any moved
    // off) and Stock draws. Lines received to the Warehouse or moved to another job are not here.
    supabaseAdmin.from('job_material_usage').select('id, cost_centre_id, quantity, unit_cost, source, billable, material_id, created_at, materials(name), purchase_order_line_items(description, purchase_orders(po_number))').eq('project_id', projectId).order('created_at'),
    supabaseAdmin.from('invoice_line_items').select('invoice_id, cost_centre_id, kind, labour_amount, material_amount, job_material_usage_id, time_entry_ids, invoices!inner(project_id, invoice_number)').eq('invoices.project_id', projectId),
    // do-and-charge invoices on this job that can still be added to (item 64)
    supabaseAdmin.from('invoices').select('id, invoice_number, sent_at, invoice_line_items(id)').eq('project_id', projectId).is('xero_invoice_id', null).is('paid_at', null).order('sent_at', { ascending: false }),
    shared || loadActualsShared(supabaseAdmin),
  ]);
  failOnReadError([entriesRead, usageRead, invItemsRead, openInvoicesRead]);
  const entries = entriesRead.data, usage = usageRead.data, invItems = invItemsRead.data, openInvoices = openInvoicesRead.data;
  const { settings, holidays, tiers } = lookups;

  const staffIds = [...new Set((entries || []).map(e => e.staff_id))];
  const [profilesRead, rateCard] = await Promise.all([
    staffIds.length ? supabaseAdmin.from('profiles').select('id, full_name, rate_tier_id').in('id', staffIds) : Promise.resolve({ data: [] }),
    rateCardFor(supabaseAdmin, projectId),  // every $/hr below is at the job's surcharge level (item 46); an agreement is its own line (item 48)
  ]);
  failOnReadError([profilesRead]);
  const profiles = profilesRead.data;
  const tierById = Object.fromEntries((tiers || []).map(t => [t.id, t]));
  const profileById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  const sellRateByProfile = {};
  (profiles || []).forEach(p => {
    const tier = tierById[p.rate_tier_id];
    sellRateByProfile[p.id] = tier ? rateAt(tier.sell_rate, rateCard.labourFactor) : 0;
  });
  const holidaySet = new Set((holidays || []).map(h => h.holiday_date));
  // the invoice being edited does not count: its shifts and materials come back as lines to keep or drop
  const otherItems = (invItems || []).filter(i => !invoiceId || i.invoice_id !== invoiceId);
  const invoiceOfEntry = new Map();
  otherItems.forEach(i => (i.time_entry_ids || []).forEach(id => invoiceOfEntry.set(id, i.invoices?.invoice_number || '')));
  const invoiceOfUsage = new Map();
  otherItems.forEach(i => { if (i.job_material_usage_id) invoiceOfUsage.set(i.job_material_usage_id, i.invoices?.invoice_number || ''); });

  const byCentre = Object.fromEntries(centres.map(c => [c.id, { hours: 0, labourSell: 0, materialCost: 0, itemInvoiced: 0, labourLines: [], materialLines: [] }]));
  (entries || []).forEach(e => {
    // Paid hours (the unpaid break comes off), shared evenly across the stages of a split
    // entry, the same way the job costing reads them.
    const hours = entryHours(e);
    const centreIds = entryCentreIds(e);
    const share = centreIds.length > 1 ? 1 / centreIds.length : 1;
    const rate = sellRateByProfile[e.staff_id] || 0;
    const profile = profileById[e.staff_id] || {};
    const billed = invoiceOfEntry.has(e.id);
    const shift = billed && !includeBilled ? null : shiftBands(e, holidaySet);
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
        billable: e.billable !== false,
        invoiced: billed,
        invoiceNumber: billed ? invoiceOfEntry.get(e.id) : null,
      });
    });
  });

  // Materials, one line each (item 41): a PO line received to the job or a Stock draw, at cost
  // and at cost plus the cost centre's markup. A line marked not billable stays in the list
  // (greyed, tick to bill it) but out of the bulk total. Lines already on an invoice are left
  // out unless includeBilled.
  (usage || []).forEach(u => {
    const billed = invoiceOfUsage.has(u.id);
    if (billed && !includeBilled) return;
    const b = byCentre[centreOf(u.cost_centre_id)];
    const billable = u.billable !== false;
    const poLine = u.purchase_order_line_items;
    if (billable && !billed) b.materialCost += (Number(u.quantity) || 0) * (Number(u.unit_cost) || 0);
    b.materialLines.push({
      usageId: u.id,
      materialId: u.material_id || null,
      description: poLine?.description || u.materials?.name || 'Material',
      from: u.source === 'from_po' ? `PO ${poLine?.purchase_orders?.po_number || ''}`.trim() : 'Stock',
      quantity: Number(u.quantity) || 0,
      unitCost: r2(u.unit_cost),
      billable,
      invoiced: billed,
      invoiceNumber: billed ? invoiceOfUsage.get(u.id) : null,
      createdAt: u.created_at,
    });
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
      materialLines: b.materialLines.map(m => ({ ...m, unitPrice: r2(m.unitCost * (1 + markupPercent / 100)) })),
    };
  });
  const sum = (k) => r2(centreRows.reduce((s, c) => s + c[k], 0));
  return {
    ok: true,
    data: {
      costCentreId: firstId,
      actualHours: sum('actualHours'),
      actualLabourSell: sum('actualLabourSell'),
      materialCost: sum('materialCost'),
      materialSell: sum('materialSell'),
      invoicedAmount: sum('invoicedAmount'),
      centres: centreRows,
      rateTiers: (tiers || []).map(t => ({ id: t.id, name: t.name, sellRate: rateAt(t.sell_rate, rateCard.labourFactor) })),
      // percentOff: the commercial agreement's reduction, which create-invoice.js adds as its own line
      rateCard: { name: rateCard.name, percent: rateCard.percent, percentOff: rateCard.percentOff },
      rules: RULES,
      invoice: editInvoice,
      openInvoices: (openInvoices || []).filter(i => (i.invoice_line_items || []).length && i.id !== invoiceId).map(i => ({ id: i.id, invoiceNumber: i.invoice_number, sentAt: i.sent_at })),
    },
  };
}

// Prices jobActuals' lines. Labour: each billable shift at its bands' multipliers; a person's
// day under the minimum is rounded up on their first not yet invoiced line of that day, at that
// line's first band rate (the panel's applyMinimum in js/project-invoice-actuals.js). Materials:
// each billable line at cost plus its stage's markup. A line already on an invoice keeps its place
// (the portal lists it) but only open lines count in the totals. A not billable line that was never
// invoiced is left out. agreementOff is the commercial agreement's percent off the open labour,
// the minus line create-invoice.js adds. lumpInvoiced is what a stage has been invoiced as plain
// amounts, tied to no shift or material line (a ServiceM8 import's invoices, materials billed in
// Bulk, a fixed-price claim): the panel takes it off its Bulk materials figure the same way.
// leftToInvoice is, stage by stage, the open work less the agreement and less that stage's lump,
// never under zero: on a job invoiced line by line it is what the next invoice would come to; where
// a lump was invoiced it is the best figure the records give, not a line by line match.
function priceActuals(d) {
  const bandOrder = Object.keys(RULES.bands);
  const labour = [];
  d.centres.forEach((c) => c.labourLines.forEach((l) => {
    if (!l.billable && !l.invoiced) return;
    const parts = Object.entries(l.bands).filter(([, h]) => h > 0);
    const amount = parts.reduce((s, [band, h]) => s + h * l.rate * (RULES.bands[band]?.multiplier || 1), 0);
    labour.push({
      line: l, centreId: c.costCentreId, parts, hours: r2(l.hours), amount: r2(amount), minimumApplied: false,
      // the panel's first row of the day is the first band with hours, so a top-up is at that band's rate
      firstBandRate: l.rate * (RULES.bands[bandOrder.find((b) => l.bands[b] > 0)]?.multiplier || 1),
    });
  }));
  labour.sort((a, b) => a.line.dateKey.localeCompare(b.line.dateKey));
  const min = Number(RULES.minimumHours) || 0;
  const byDay = new Map();
  labour.filter((x) => !x.line.invoiced).forEach((x) => {
    const k = `${x.line.staffId}|${x.line.dateKey}`;
    if (!byDay.has(k)) byDay.set(k, { total: 0, first: x });
    byDay.get(k).total += x.hours;
  });
  byDay.forEach(({ total, first }) => {
    if (min && total > 0 && total < min) {
      first.amount = r2(first.amount + (min - total) * first.firstBandRate);
      first.minimumApplied = true;
    }
  });
  const materials = [];
  d.centres.forEach((c) => c.materialLines.forEach((m) => {
    if (!m.billable && !m.invoiced) return;
    materials.push({ line: m, centreId: c.costCentreId, amount: r2(m.quantity * m.unitPrice) });
  }));
  const labourOpen = r2(labour.filter((x) => !x.line.invoiced).reduce((s, x) => s + x.amount, 0));
  const materialsOpen = r2(materials.filter((x) => !x.line.invoiced).reduce((s, x) => s + x.amount, 0));
  const percentOff = d.rateCard && d.rateCard.percentOff > 0 ? d.rateCard.percentOff : 0;
  const openIn = (list, centreId) => r2(list.filter((x) => !x.line.invoiced && x.centreId === centreId).reduce((s, x) => s + x.amount, 0));
  let agreementOff = 0, lumpInvoiced = 0, leftToInvoice = 0;
  d.centres.forEach((c) => {
    const stageLabour = openIn(labour, c.costCentreId);
    const off = percentOff ? r2(stageLabour * percentOff / 100) : 0;
    const lump = r2(c.invoicedAmount);
    agreementOff += off;
    lumpInvoiced += lump;
    leftToInvoice += Math.max(0, stageLabour - off + openIn(materials, c.costCentreId) - lump);
  });
  return {
    labour, materials, labourOpen, materialsOpen,
    notInvoiced: r2(labourOpen + materialsOpen),
    agreementOff: r2(agreementOff), lumpInvoiced: r2(lumpInvoiced), leftToInvoice: r2(leftToInvoice),
  };
}

module.exports = { jobActuals, priceActuals, loadActualsShared };
