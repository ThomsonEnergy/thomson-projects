// POST /api/create-invoice
// Body: { projectId, claims: [{ costCentreId, labourAmount, materialAmount, stcAmount, claimPercent, items? }],
//         variationEntryIds? (logged variations being billed on this invoice) }
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

  const undo = { supabaseAdmin: null, invoiceId: null, usageIds: [], stock: [], added: [] };
  try {
    const { projectId, claims, sentAt, dueDate: overrideDueDate, billToClientId, variationEntryIds } = JSON.parse(event.body || '{}');

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
        bstc_amount: Number(c.bstcAmount) || 0, // battery credit, kept apart from the solar one
        claim_percent: c.claimPercent != null ? Number(c.claimPercent) : null,
        _items: priced.rows,
      }))
      .filter(c => c.cost_centre_id && (c.labour_amount + c.material_amount + c.stc_amount + c.bstc_amount) > 0);
    if (!claimRows.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'At least one cost centre needs a non-zero claim amount' }) };
    }
    // Server-side limits (the panel limits them too): no negative parts, and a quoted stage can't
    // be claimed past what is left of it (a cent of rounding allowed). Bug review M9.
    if (claimRows.some(c => c.labour_amount < 0 || c.material_amount < 0 || c.stc_amount < 0 || c.bstc_amount < 0)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Claim amounts can not be negative.' }) };
    }
    // Stock / prebuild items added on the invoice are extra on top, so only the typed claim is limited.
    // Estimates and time-and-materials jobs bill actuals, which can run past the estimate: not limited.
    const { data: jobForCap } = await supabaseAdmin.from('projects').select('proposal_template, stc_total, bstc_total').eq('id', projectId).maybeSingle();
    const capped = !['quick_estimate', 'time_and_materials', 'direct_job'].includes(jobForCap?.proposal_template);
    for (const { c } of (capped ? pricedClaims : [])) {
      const centre = (allCentres || []).find(cc => cc.id === c.costCentreId);
      const quoted = Number(centre?.quoted_amount) || 0;
      if (centre && quoted > 0) {
        const left = r2(quoted - (Number(centre.invoiced_amount) || 0));
        if (r2((Number(c.labourAmount) || 0) + (Number(c.materialAmount) || 0)) > left + 0.01) {
          return { statusCode: 400, body: JSON.stringify({ error: `${centre.name}: only $${left.toFixed(2)} is left to claim on this stage.` }) };
        }
      }
    }

    const totalLabour = claimRows.reduce((s, c) => s + c.labour_amount, 0);
    const totalMaterial = claimRows.reduce((s, c) => s + c.material_amount, 0);
    const totalStc = claimRows.reduce((s, c) => s + c.stc_amount, 0);
    const totalBstc = claimRows.reduce((s, c) => s + c.bstc_amount, 0);
    const totalAmount = totalLabour + totalMaterial;

    // An invoice is work with a credit on it, never a credit on its own, and never less than nothing (Xero
    // refuses a negative invoice and the pay link would charge a negative balance). Bug review M7.
    if (r2(totalAmount) <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'An invoice needs labour or materials on it. A credit on its own is not an invoice.' }) };
    }
    if (r2(totalStc + totalBstc) > r2(totalAmount) + 0.01) {
      return { statusCode: 400, body: JSON.stringify({ error: 'The STC and BSTC credits on this claim are more than the work claimed, so the invoice would be negative. Claim more of the stage with the credits, or less credit.' }) };
    }
    // The credits are the quote's (projects.stc_total and bstc_total): a claim can carry at most what is left of
    // each after every earlier claim and credit note on the job, the same figure the claim panel shows
    // (quoteCreditSummary in project.html, where a credit note gives the credit back). A failed read here
    // refuses the claim, it never loosens the cap.
    if (totalStc > 0 || totalBstc > 0) {
      const centreIds = (allCentres || []).map(cc => cc.id);
      const [{ data: byProject, error: byProjectErr }, { data: byCentre, error: byCentreErr }] = await Promise.all([
        supabaseAdmin.from('invoices').select('id, stc_amount, bstc_amount').eq('project_id', projectId),
        centreIds.length ? supabaseAdmin.from('invoices').select('id, stc_amount, bstc_amount').in('cost_centre_id', centreIds) : Promise.resolve({ data: [], error: null }),
      ]);
      if (byProjectErr) throw byProjectErr;
      if (byCentreErr) throw byCentreErr;
      const seen = new Set();
      const jobInvoices = [...(byProject || []), ...(byCentre || [])].filter(inv => !seen.has(inv.id) && seen.add(inv.id));
      const invoiceIds = jobInvoices.map(inv => inv.id);
      const { data: credited, error: creditedErr } = invoiceIds.length
        ? await supabaseAdmin.from('credit_note_claims').select('stc_amount, bstc_amount, credit_notes!inner(invoice_id)').in('credit_notes.invoice_id', invoiceIds)
        : { data: [], error: null };
      if (creditedErr) throw creditedErr;
      const sum = (rows, key) => (rows || []).reduce((s, row) => s + (Number(row[key]) || 0), 0);
      const stcLeft = Math.max(0, r2((Number(jobForCap?.stc_total) || 0) - sum(jobInvoices, 'stc_amount') + sum(credited, 'stc_amount')));
      const bstcLeft = Math.max(0, r2((Number(jobForCap?.bstc_total) || 0) - sum(jobInvoices, 'bstc_amount') + sum(credited, 'bstc_amount')));
      if (r2(totalStc) > stcLeft + 0.01) {
        return { statusCode: 400, body: JSON.stringify({ error: `Only $${stcLeft.toFixed(2)} of the STC credit is left to claim on this job.` }) };
      }
      if (r2(totalBstc) > bstcLeft + 0.01) {
        return { statusCode: 400, body: JSON.stringify({ error: `Only $${bstcLeft.toFixed(2)} of the BSTC credit is left to claim on this job.` }) };
      }
    }

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
    const isFinalClaim = projectTotal > 0 && (allCentres || []).every(c => {
      const claimedForThisCentre = claimRows.find(cr => cr.cost_centre_id === c.id);
      const newInvoiced = (Number(c.invoiced_amount) || 0) + (claimedForThisCentre ? claimedForThisCentre.labour_amount + claimedForThisCentre.material_amount : 0);
      return newInvoiced >= (Number(c.quoted_amount) || 0) - 0.01;
    });

    const { data: projectRow } = await supabaseAdmin.from('projects').select('client_id, proposal_template').eq('id', projectId).single();

    let claimLabel;
    if (projectRow?.proposal_template === 'direct_job' && projectTotal <= 0) {
      // No quote to claim against: name the invoice after the cost centres
      // it covers (e.g. "Disconnect" or "Disconnect + Reconnect"), which is
      // also what the Xero reference reads ("Job 7000 - Disconnect").
      claimLabel = claimRows
        .map(c => (allCentres || []).find(cc => cc.id === c.cost_centre_id))
        .sort((a, b) => (a?.sort_order || 0) - (b?.sort_order || 0))
        .map(cc => cc?.name || 'Work')
        .join(' + ')
        .slice(0, 200);
    } else if (isFinalClaim) {
      claimLabel = 'Final claim';
    } else {
      const { data: priorInvoices } = await supabaseAdmin.from('invoices').select('description').eq('project_id', projectId);
      const priorProgressCount = (priorInvoices || []).filter(inv => inv.description !== 'Deposit' && inv.description !== 'Final claim').length;
      claimLabel = `Progress claim ${priorProgressCount + 1}`;
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
      // Count terms from the Sydney calendar date (the UTC date is yesterday before 10/11am).
      dueDate = computeDueDate(client?.payment_terms || 'cod', new Date(invoiceDate).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }));
    }

    // If anything after the invoice row fails, take back what was done so far (no half-made invoice
    // with a used SI number and no claims, no stock taken out for nothing). Bug review M9.
    undo.supabaseAdmin = supabaseAdmin;
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
        bstc_amount: totalBstc,
        claim_percent: overallClaimPercent,
        sent_at: invoiceDate,
        due_date: dueDate,
        created_by: user.id,
        bill_to_client_id: billToClientId || null,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;
    undo.invoiceId = insertedInvoice.id;

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
          undo.usageIds.push(usage.id);
          await adjustWarehouseStockAdmin(supabaseAdmin, item.material_id, -Number(item.quantity));
          undo.stock.push({ materialId: item.material_id, qty: Number(item.quantity) });
        }
        itemRows.push({
          ...item, invoice_id: insertedInvoice.id, invoice_claim_id: claimId, cost_centre_id: c.cost_centre_id,
          job_material_usage_id: usageId, created_by: user.id,
        });
      }
      const { error: itemsErr } = await supabaseAdmin.from('invoice_line_items').insert(itemRows);
      if (itemsErr) throw itemsErr;
    }

    // Added in one step in the database, so two invoices raised at once can't lose one.
    for (const c of claimRows) {
      const { error: addErr } = await supabaseAdmin.rpc('add_invoiced_amount', { p_centre_id: c.cost_centre_id, p_amount: r2(c.labour_amount + c.material_amount) });
      if (addErr) throw addErr;
      undo.added.push({ centreId: c.cost_centre_id, amount: r2(c.labour_amount + c.material_amount) });
    }
    undo.invoiceId = null; // done: nothing to take back from here on

    // Logged variations (bill-variations.js made each one a stage, claimed above)
    // are now billed on this invoice.
    if (Array.isArray(variationEntryIds) && variationEntryIds.length) {
      await supabaseAdmin.from('job_variation_entries').update({
        status: 'billed', invoice_id: insertedInvoice.id, status_changed_by: user.id, status_changed_at: new Date().toISOString(),
      }).in('id', variationEntryIds).eq('project_id', projectId);
    }

    // The final claim landing while the job's sitting at Ready to Invoice
    // (reached once client handover is done) is exactly the "invoice
    // sent" moment the pipeline board is waiting on - a progress claim
    // raised earlier, mid-install, shouldn't touch the stage at all.
    if (isFinalClaim) {
      await supabaseAdmin.from('projects').update({ pipeline_stage: 'awaiting_payment' }).eq('id', projectId).eq('pipeline_stage', 'ready_to_invoice');
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
      body: JSON.stringify({ ok: true, invoiceId: insertedInvoice.id, invoiceNumber: invoiceNumberStr, invoiceToken }),
    };
  } catch (err) {
    console.error(err);
    if (undo.invoiceId && undo.supabaseAdmin) {
      const db = undo.supabaseAdmin;
      try {
        for (const a of undo.added) await db.rpc('add_invoiced_amount', { p_centre_id: a.centreId, p_amount: -a.amount });
        for (const st of undo.stock) await adjustWarehouseStockAdmin(db, st.materialId, st.qty);
        await db.from('invoice_line_items').delete().eq('invoice_id', undo.invoiceId);
        if (undo.usageIds.length) await db.from('job_material_usage').delete().in('id', undo.usageIds);
        await db.from('invoice_claims').delete().eq('invoice_id', undo.invoiceId);
        await db.from('invoices').delete().eq('id', undo.invoiceId);
      } catch (undoErr) {
        console.error('create-invoice: could not take back the part-made invoice', undo.invoiceId, undoErr.message);
      }
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
