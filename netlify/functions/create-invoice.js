// POST /api/create-invoice
// Body: { projectId, claims: [{ costCentreId, labourAmount, materialAmount, stcAmount, claimPercent, items? }],
//         variationEntryIds? (logged variations being billed on this invoice),
//         invoiceType?: 'final' | 'progress' }
// invoiceType is what the person raising the invoice chose: 'final' means
// there's nothing more to invoice on this job (labelled "Final claim"
// and moves the job on to Invoice Sent - Awaiting Payment),
// 'progress' means there's more to come ("Progress claim N"). Left out (the
// warranty close-out panel), it's worked out from the quote as before.
// items (do-and-charge invoice builder): Stock materials and prebuilds added
// straight onto this invoice under that cost centre -
// [{ kind: 'material' | 'prebuild', materialId?, prebuildId?, quantity, unitPrice?, description? }].
// Priced by _shared/invoice-items.js and added on top of the claim's
// labour/material amounts; each is recorded in invoice_line_items, and a
// Stock material is taken out of the warehouse and costed to the job
// (job_material_usage), same as any other draw from Stock. Nothing is
// priced or moved until the request is otherwise valid.
// One invoice, one row per cost centre included (a single-stage claim is
// just claims.length === 1) - either a % of that stage's quote (the
// normal claim panel) or, for a no-quote job (proposal_template
// 'direct_job'), whatever's actually accrued (see
// get-invoiceable-actuals.js / openInvoiceActualCostsPanel). Standalone
// invoices with no job behind them at all have been removed - every
// invoice now comes from an actual job, even a quote-free one, since
// dashboard.html's "+ New job (no quote)" makes starting one trivial.
// Invoice numbers are always auto-assigned server-side, never accepted
// from the caller. Pricing roles only.

const crypto = require('crypto');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { computeDueDate } = require('./_shared/compute-due-date');
const { priceInvoiceItems, adjustWarehouseStockAdmin, r2 } = require('./_shared/invoice-items');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { projectId, claims, sentAt, dueDate: overrideDueDate, billToClientId, variationEntryIds, invoiceType } = JSON.parse(event.body || '{}');
    if (invoiceType != null && !['final', 'progress'].includes(invoiceType)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceType must be final or progress' }) };
    }

    if (!projectId || !Array.isArray(claims) || !claims.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId and at least one claim are required' }) };
    }

    const { data: allCentres } = await supabaseAdmin.from('cost_centres').select('id, name, sort_order, quoted_amount, invoiced_amount, markup_percent').eq('project_id', projectId);
    if (claims.some(c => c.costCentreId && !(allCentres || []).some(cc => cc.id === c.costCentreId))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A cost centre on this invoice does not belong to this job.' }) };
    }

    // Items are priced here (server side, from Stock / the prebuild library)
    // and added on top of whatever labour / materials the claim carries.
    const pricedClaims = await Promise.all(claims.map(async (c) => {
      const centre = (allCentres || []).find(cc => cc.id === c.costCentreId);
      const priced = await priceInvoiceItems(supabaseAdmin, c.items, centre?.markup_percent ?? 45);
      return { c, priced };
    }));
    const claimRows = pricedClaims
      .map(({ c, priced }) => ({
        cost_centre_id: c.costCentreId,
        labour_amount: r2((Number(c.labourAmount) || 0) + priced.labour),
        material_amount: r2((Number(c.materialAmount) || 0) + priced.material),
        stc_amount: Number(c.stcAmount) || 0,
        claim_percent: c.claimPercent != null ? Number(c.claimPercent) : null,
        _items: priced.rows,
      }))
      .filter(c => c.cost_centre_id && (c.labour_amount + c.material_amount + c.stc_amount) > 0);
    if (!claimRows.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'At least one cost centre needs a non-zero claim amount' }) };
    }

    const totalLabour = claimRows.reduce((s, c) => s + c.labour_amount, 0);
    const totalMaterial = claimRows.reduce((s, c) => s + c.material_amount, 0);
    const totalStc = claimRows.reduce((s, c) => s + c.stc_amount, 0);
    const totalAmount = totalLabour + totalMaterial;

    // Always auto-assigned, never user-typed - a manually-entered number
    // could collide with or skip the real sequence.
    const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
    if (numErr) throw numErr;
    const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
    const invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;

    const projectTotal = (allCentres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
    // Null (not a misleading 0%/100%) when there's no quote behind this job
    // at all (a direct/no-quote job) - there's nothing for a % to mean.
    const overallClaimPercent = projectTotal > 0 ? Math.round((totalAmount / projectTotal) * 10000) / 100 : null;

    // "Final claim" if this invoice brings every stage to fully invoiced -
    // meaningless for a no-quote job (quoted_amount is always 0 there, so
    // this would trivially call EVERY invoice "Final claim" even when
    // there's plenty more to invoice later), so that's never a final
    // claim, always "Progress claim N" instead. Otherwise N is how many
    // non-deposit invoices this job already has, +1. Counted in JS rather
    // than a .neq() filter so a null description (every progress claim
    // raised before this label existed) still correctly counts as "not
    // the deposit", not gets silently excluded by SQL's
    // null != 'Deposit' => null semantics.
    const autoFinal = projectTotal > 0 && (allCentres || []).every(c => {
      const claimedForThisCentre = claimRows.find(cr => cr.cost_centre_id === c.id);
      const newInvoiced = (Number(c.invoiced_amount) || 0) + (claimedForThisCentre ? claimedForThisCentre.labour_amount + claimedForThisCentre.material_amount : 0);
      return newInvoiced >= (Number(c.quoted_amount) || 0) - 0.01;
    });
    const isFinalClaim = invoiceType ? invoiceType === 'final' : autoFinal;

    const { data: projectRow } = await supabaseAdmin.from('projects').select('client_id, proposal_template').eq('id', projectId).single();

    let claimLabel;
    if (isFinalClaim) {
      claimLabel = 'Final claim';
    } else {
      const { data: priorInvoices } = await supabaseAdmin.from('invoices').select('description').eq('project_id', projectId);
      const priorProgressCount = (priorInvoices || []).filter(inv => inv.description !== 'Deposit' && !/^Final /.test(inv.description || '')).length;
      claimLabel = `Progress claim ${priorProgressCount + 1}`;
    }
    if (projectRow?.proposal_template === 'direct_job' && projectTotal <= 0) {
      // No quote to claim against: also name the cost centres it covers
      // ("Final claim - Disconnect + Reconnect", "Progress claim 1 -
      // Disconnect"), which is what the Xero reference reads too.
      const centreNames = claimRows
        .map(c => (allCentres || []).find(cc => cc.id === c.cost_centre_id))
        .sort((a, b) => (a?.sort_order || 0) - (b?.sort_order || 0))
        .map(cc => cc?.name || 'Work')
        .join(' + ');
      claimLabel = `${claimLabel} - ${centreNames}`.slice(0, 200);
    }

    const invoiceToken = crypto.randomUUID();
    const invoiceDate = sentAt ? new Date(sentAt).toISOString() : new Date().toISOString();

    // Due date defaults from the client's own payment terms (COD unless
    // they're set up as net 7/14/30), but whoever's raising the invoice
    // can override it below.
    let dueDate = overrideDueDate || null;
    if (!dueDate) {
      const resolvedClientId = projectRow?.client_id;
      const { data: client } = resolvedClientId
        ? await supabaseAdmin.from('clients').select('payment_terms').eq('id', resolvedClientId).maybeSingle()
        : { data: null };
      dueDate = computeDueDate(client?.payment_terms || 'cod', invoiceDate);
    }

    const { data: insertedInvoice, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert({
        project_id: projectId,
        cost_centre_id: null, // stage detail always lives in invoice_claims now
        client_id: null,
        description: claimLabel,
        invoice_number: invoiceNumberStr,
        invoice_token: invoiceToken,
        labour_amount: totalLabour,
        material_amount: totalMaterial,
        stc_amount: totalStc,
        claim_percent: overallClaimPercent,
        sent_at: invoiceDate,
        due_date: dueDate,
        created_by: user.id,
        bill_to_client_id: billToClientId || null,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    const { data: insertedClaims, error: claimsErr } = await supabaseAdmin
      .from('invoice_claims')
      .insert(claimRows.map(({ _items, ...c }) => ({ ...c, invoice_id: insertedInvoice.id })))
      .select('id, cost_centre_id');
    if (claimsErr) throw claimsErr;

    // Items added in the invoice builder: Stock comes out of the warehouse
    // and is costed to the job, then each item is recorded against its claim.
    for (const c of claimRows) {
      if (!c._items.length) continue;
      const claimId = (insertedClaims || []).find(ic => ic.cost_centre_id === c.cost_centre_id)?.id || null;
      const itemRows = [];
      for (const item of c._items) {
        let usageId = null;
        if (item.kind === 'material' && item.material_id) {
          const { data: usage, error: usageErr } = await supabaseAdmin.from('job_material_usage').insert({
            project_id: projectId, cost_centre_id: c.cost_centre_id, material_id: item.material_id,
            quantity: item.quantity, unit_cost: item.unit_cost, source: 'from_stock', created_by: user.id,
          }).select('id').single();
          if (usageErr) throw usageErr;
          usageId = usage.id;
          await adjustWarehouseStockAdmin(supabaseAdmin, item.material_id, -Number(item.quantity));
        }
        itemRows.push({
          ...item, invoice_id: insertedInvoice.id, invoice_claim_id: claimId, cost_centre_id: c.cost_centre_id,
          job_material_usage_id: usageId, created_by: user.id,
        });
      }
      const { error: itemsErr } = await supabaseAdmin.from('invoice_line_items').insert(itemRows);
      if (itemsErr) throw itemsErr;
    }

    const { data: centresBefore } = await supabaseAdmin
      .from('cost_centres')
      .select('id, invoiced_amount')
      .in('id', claimRows.map(c => c.cost_centre_id));
    await Promise.all(claimRows.map(c => {
      const before = Number((centresBefore || []).find(cc => cc.id === c.cost_centre_id)?.invoiced_amount) || 0;
      return supabaseAdmin.from('cost_centres').update({ invoiced_amount: before + c.labour_amount + c.material_amount }).eq('id', c.cost_centre_id);
    }));

    // Logged variations (bill-variations.js made each one a stage, claimed above)
    // are now billed on this invoice.
    if (Array.isArray(variationEntryIds) && variationEntryIds.length) {
      await supabaseAdmin.from('job_variation_entries').update({
        status: 'billed', invoice_id: insertedInvoice.id, status_changed_by: user.id, status_changed_at: new Date().toISOString(),
      }).in('id', variationEntryIds).eq('project_id', projectId);
    }

    // The final claim is the "invoice sent" moment the pipeline board is
    // waiting on. Worked out automatically, it only moves a job already at
    // Ready to Invoice (reached once client handover is done). Chosen as
    // final by the person raising it, it moves the job on from any stage
    // the work could be at (e.g. a do-and-charge disconnect/reconnect that
    // never goes through handover). A progress claim never touches the stage.
    let pipelineStage = null;
    if (isFinalClaim) {
      const fromStages = invoiceType === 'final' ? ['job_booked', 'job_not_complete', 'client_handover', 'ready_to_invoice'] : ['ready_to_invoice'];
      const { data: moved } = await supabaseAdmin.from('projects').update({ pipeline_stage: 'awaiting_payment' }).eq('id', projectId).in('pipeline_stage', fromStages).select('id');
      if ((moved || []).length) pipelineStage = 'awaiting_payment';
    }

    // No Airwallex payment link is created here. It's generated on demand
    // the moment the client actually clicks "Pay online" on the invoice
    // page (see get-or-create-payment-link.js) - two deliberate reasons:
    // the amount gets computed fresh at that exact moment rather than
    // cached from invoice creation, and no Airwallex object ever gets
    // created for the (likely common) case of a client who just pays by
    // bank transfer and never clicks the button at all.

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, invoiceId: insertedInvoice.id, invoiceNumber: invoiceNumberStr, invoiceToken, isFinal: isFinalClaim, description: claimLabel, pipelineStage }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
