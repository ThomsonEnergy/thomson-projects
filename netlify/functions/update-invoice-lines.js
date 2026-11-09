// POST /.netlify/functions/update-invoice-lines
// Body: { invoiceId, claims: [{ costCentreId, materialAmount?, items: [...] }], billable?, notBillable?,
//         sentAt?, dueDate?, notes? }
//   items: the same shape create-invoice.js takes ({ kind: 'material' | 'prebuild' | 'labour' | 'custom',
//          materialId?, jobMaterialUsageId?, prebuildId?, quantity, unitPrice?, unitCost?, description?,
//          staffId?, rateTierId?, timeEntryIds? }); a material line already on this invoice keeps its
//          jobMaterialUsageId, so the Stock it took out stays out (resized when its quantity changes)
//   materialAmount: a stage's materials billed as one amount (an invoice made in Bulk mode)
// Edits a do-and-charge invoice before it reaches Xero (item 64): the Invoice actual costs panel
// (js/project-invoice-actuals.js) sends the whole new set of lines; this prices them exactly as
// create-invoice.js does (_shared/invoice-items.js: Stock cost plus markup, prebuilds, rate tiers at the
// job's level, the commercial agreement line) and checks every shift and material is on the job and not
// billed on another invoice; then edit_invoice_lines (migration 20261130040000) applies the change in one
// transaction: claims, lines, Stock in and out, each stage's invoiced_amount, the invoice totals and
// dates, the PDF dropped, one history line. Pricing roles only. Refused once the invoice is in Xero or
// paid (a credit note is the correction then).

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { priceInvoiceItems, commercialAgreementRow, r2 } = require('./_shared/invoice-items');
const { rateCardFor } = require('./_shared/rate-cards');
const { moneyText } = require('./_shared/invoice-events');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error) => ({ statusCode: 400, body: JSON.stringify({ ok: false, error }) });
// What a line is, for counting what changed: the usage row, the shifts, the prebuild or the words.
const lineKey = (l) => l.job_material_usage_id ? `u:${l.job_material_usage_id}`
  : (l.time_entry_ids && l.time_entry_ids.length) ? `t:${[...l.time_entry_ids].sort().join(',')}:${l.description}`
  : l.prebuild_id ? `p:${l.prebuild_id}:${l.description}`
  : `d:${l.kind}:${l.description}`;
const isServerLine = (l) => /^Commercial agreement \(/.test(l.description || '');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { invoiceId, claims, billable, notBillable, sentAt, dueDate, notes } = JSON.parse(event.body || '{}');
    if (!UUID.test(invoiceId || '') || !Array.isArray(claims)) return bad('invoiceId and claims are required');

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, project_id, invoice_number, labour_amount, material_amount, xero_invoice_id, paid_at, invoice_claims(cost_centre_id, labour_amount, material_amount, stc_amount, bstc_amount), invoice_line_items(id, kind, description, quantity, unit_price, job_material_usage_id, time_entry_ids, prebuild_id)')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!invoice) return bad('Invoice not found.');
    if (invoice.xero_invoice_id) return bad('This invoice is in Xero. Changes go through a credit note.');
    if (invoice.paid_at) return bad('This invoice is paid and cannot be edited.');
    if (!invoice.project_id) return bad('This invoice has no job.');
    const projectId = invoice.project_id;

    const [{ data: allCentres }, { data: projectRow }] = await Promise.all([
      supabaseAdmin.from('cost_centres').select('id, name, sort_order, markup_percent, quoted_amount').eq('project_id', projectId),
      supabaseAdmin.from('projects').select('client_id').eq('id', projectId).maybeSingle(),
    ]);
    const centreById = Object.fromEntries((allCentres || []).map(c => [c.id, c]));
    // a quoted claim (no line items, a quoted total) is edited as per-stage numbers, not as lines
    const projectTotal = (allCentres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
    if (!(invoice.invoice_line_items || []).length && projectTotal > 0) return bad('This is a quoted claim: edit its amounts with the per-stage Edit, not as lines.');
    const wanted = claims.filter(c => c && c.costCentreId && ((Array.isArray(c.items) && c.items.length) || Number(c.materialAmount) > 0));
    if (wanted.some(c => !centreById[c.costCentreId])) return bad('A stage on this invoice does not belong to this job.');
    if (!wanted.length) return bad('An invoice needs at least one line. To take it off the job, issue a credit note or leave the invoice as it is.');
    // a stage that carries an STC or BSTC credit on this invoice has to keep at least one line
    const oldClaimByCentre = Object.fromEntries((invoice.invoice_claims || []).map(c => [c.cost_centre_id, c]));
    const droppedWithCredit = (invoice.invoice_claims || []).find(c => (Number(c.stc_amount) || 0) + (Number(c.bstc_amount) || 0) > 0 && !wanted.some(w => w.costCentreId === c.cost_centre_id));
    if (droppedWithCredit) return bad(`${centreById[droppedWithCredit.cost_centre_id]?.name || 'A stage'} carries an STC credit on this invoice: keep at least one line on it.`);

    // priced exactly as on create
    const rateCard = await rateCardFor(supabaseAdmin, projectId);
    let agreementTotal = 0;
    const pricedClaims = await Promise.all(wanted.map(async (c) => {
      const centre = centreById[c.costCentreId];
      const priced = await priceInvoiceItems(supabaseAdmin, c.items || [], centre.markup_percent ?? 45, rateCard.labourFactor);
      const agreement = commercialAgreementRow(priced.labour, rateCard, priced.rows.length);
      if (agreement) {
        priced.rows.push(agreement);
        priced.labour = r2(priced.labour + agreement.labour_amount);
        agreementTotal = r2(agreementTotal - agreement.labour_amount);
      }
      return { c, priced };
    }));

    // every shift and material on the new set is on this job and on no other invoice
    const billedEntryIds = [...new Set(pricedClaims.flatMap(({ priced }) => priced.rows.flatMap(r => r.time_entry_ids || [])))];
    if (billedEntryIds.length) {
      const [{ data: ownEntries }, { data: elsewhere }] = await Promise.all([
        supabaseAdmin.from('time_entries').select('id').eq('project_id', projectId).in('id', billedEntryIds),
        supabaseAdmin.from('invoice_line_items').select('id, invoices!inner(project_id)').eq('invoices.project_id', projectId).neq('invoice_id', invoiceId).overlaps('time_entry_ids', billedEntryIds).limit(1),
      ]);
      if ((ownEntries || []).length !== billedEntryIds.length) return bad('A shift on this invoice is not on this job.');
      if ((elsewhere || []).length) return bad('A shift on this invoice is already billed on another invoice. Close the panel and open it again.');
    }
    const billedUsageIds = [...new Set(pricedClaims.flatMap(({ priced }) => priced.rows.map(r => r.job_material_usage_id).filter(Boolean)))];
    if (billedUsageIds.length) {
      const [{ data: ownUsage }, { data: elsewhere }] = await Promise.all([
        supabaseAdmin.from('job_material_usage').select('id').eq('project_id', projectId).in('id', billedUsageIds),
        supabaseAdmin.from('invoice_line_items').select('id').in('job_material_usage_id', billedUsageIds).neq('invoice_id', invoiceId).limit(1),
      ]);
      if ((ownUsage || []).length !== billedUsageIds.length) return bad('A material on this invoice is not costed to this job.');
      if ((elsewhere || []).length) return bad('A material on this invoice is already billed on another invoice. Close the panel and open it again.');
    }

    const payloadClaims = pricedClaims.map(({ c, priced }) => {
      const old = oldClaimByCentre[c.costCentreId];
      return {
        cost_centre_id: c.costCentreId,
        labour_amount: r2(priced.labour),
        material_amount: r2((Number(c.materialAmount) || 0) + priced.material),
        stc_amount: Number(old?.stc_amount) || 0,
        bstc_amount: Number(old?.bstc_amount) || 0,
        lines: priced.rows,
      };
    });
    if (payloadClaims.some(c => c.labour_amount < 0 || c.material_amount < 0)) return bad('A stage total cannot be negative. Check the Less line.');
    const newTotal = r2(payloadClaims.reduce((s, c) => s + c.labour_amount + c.material_amount, 0));
    if (newTotal <= 0) return bad('An invoice needs labour or materials on it.');

    // what changed, in words, for the history line
    const oldLines = (invoice.invoice_line_items || []).filter(l => !isServerLine(l));
    const newLines = payloadClaims.flatMap(c => c.lines).filter(l => !isServerLine(l));
    const oldByKey = new Map(oldLines.map(l => [lineKey(l), l]));
    const newByKey = new Map(newLines.map(l => [lineKey(l), l]));
    let added = 0, removed = 0, changed = 0;
    newByKey.forEach((l, k) => {
      const o = oldByKey.get(k);
      if (!o) added += 1;
      else if (Math.abs(Number(o.quantity) - Number(l.quantity)) > 0.0001 || Math.abs(Number(o.unit_price) - Number(l.unit_price)) > 0.0001) changed += 1;
    });
    oldByKey.forEach((o, k) => { if (!newByKey.has(k)) removed += 1; });
    const oldTotal = r2((Number(invoice.labour_amount) || 0) + (Number(invoice.material_amount) || 0));
    const words = [`Total ex GST ${moneyText(oldTotal)} to ${moneyText(newTotal)}`];
    if (added) words.push(`${added} line${added === 1 ? '' : 's'} added`);
    if (removed) words.push(`${removed} removed`);
    if (changed) words.push(`${changed} changed`);

    // the note under the totals (item 48) and, on a no-quote job, the name (its stage names) follow the lines
    let commercialAgreement = null;
    if (agreementTotal > 0) {
      const { data: agreementClient } = projectRow?.client_id
        ? await supabaseAdmin.from('clients').select('agreement_sent_at').eq('id', projectRow.client_id).maybeSingle()
        : { data: null };
      commercialAgreement = { name: rateCard.name, percent_off: rateCard.percentOff, amount: agreementTotal, sent_at: agreementClient?.agreement_sent_at || null };
    }
    const description = projectTotal <= 0
      ? payloadClaims.map(c => centreById[c.cost_centre_id]).sort((a, b) => (a?.sort_order || 0) - (b?.sort_order || 0)).map(cc => cc?.name || 'Work').join(' + ').slice(0, 200)
      : null;
    const sentAtOk = sentAt && !Number.isNaN(Date.parse(sentAt));
    const payload = {
      actor_id: user.id,
      claims: payloadClaims,
      detail: words.join(', '),
      commercial_agreement: commercialAgreement,
      ...(description ? { description } : {}),
      ...(sentAtOk ? { sent_at: new Date(sentAt).toISOString() } : {}),
      ...(dueDate !== undefined ? { due_date: dueDate || null } : {}),
      ...(notes !== undefined ? { notes: String(notes || '').trim().slice(0, 2000) || null } : {}),
    };
    const { data: result, error: editErr } = await supabaseAdmin.rpc('edit_invoice_lines', { p_invoice_id: invoiceId, p_payload: payload });
    if (editErr) return bad(editErr.message.replace(/^.*?: /, ''));

    // The Bill ticks (item 41): the same marks create-invoice.js saves, never a reason to fail the edit.
    try {
      const ids = (o, k) => [...new Set((Array.isArray(o?.[k]) ? o[k] : []).filter(v => typeof v === 'string'))];
      const marks = [
        ['time_entries', ids(notBillable, 'timeEntryIds'), false], ['time_entries', ids(billable, 'timeEntryIds'), true],
        ['job_material_usage', ids(notBillable, 'usageIds'), false], ['job_material_usage', ids(billable, 'usageIds'), true],
      ];
      for (const [table, list, value] of marks) {
        if (!list.length) continue;
        const { error: markErr } = await supabaseAdmin.from(table).update({ billable: value }).eq('project_id', projectId).in('id', list);
        if (markErr) throw markErr;
      }
    } catch (markErr) {
      console.error('update-invoice-lines billable marks failed:', markErr.message);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceId, invoiceNumber: invoice.invoice_number, oldTotal: Number(result?.old_total ?? oldTotal), newTotal: Number(result?.new_total ?? newTotal) }) };
  } catch (err) {
    console.error('update-invoice-lines error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
