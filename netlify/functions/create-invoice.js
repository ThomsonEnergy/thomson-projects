// POST /api/create-invoice
// Body EITHER: { projectId, claims: [{ costCentreId, labourAmount, materialAmount, stcAmount, claimPercent }], invoiceNumber }
//   for a job-linked claim - one invoice, one row per cost centre included
//   (a single-stage claim is just claims.length === 1), OR
// { clientId, description, labourAmount, materialAmount, invoiceNumber }
//   for a standalone invoice with no job/quote behind it.
// Pricing roles only. Creates a new row in the invoices table (plus one
// invoice_claims row per claimed cost centre for a job-linked claim).

const crypto = require('crypto');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { computeDueDate } = require('./_shared/compute-due-date');

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
    const {
      projectId,
      claims,
      clientId,
      description,
      labourAmount = 0,
      materialAmount = 0,
      stcAmount = 0,
      claimPercent = 100,
      invoiceNumber: overrideNumber,
      sentAt,
      dueDate: overrideDueDate,
    } = JSON.parse(event.body || '{}');

    const isJobClaim = !!projectId && Array.isArray(claims) && claims.length > 0;
    if (!isJobClaim && !clientId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Either projectId+claims (job claim) or clientId (standalone invoice) is required' }) };
    }

    const claimRows = isJobClaim
      ? claims
          .map(c => ({
            cost_centre_id: c.costCentreId,
            labour_amount: Number(c.labourAmount) || 0,
            material_amount: Number(c.materialAmount) || 0,
            stc_amount: Number(c.stcAmount) || 0,
            claim_percent: c.claimPercent != null ? Number(c.claimPercent) : null,
          }))
          .filter(c => c.cost_centre_id && (c.labour_amount + c.material_amount + c.stc_amount) > 0)
      : [];
    if (isJobClaim && !claimRows.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'At least one cost centre needs a non-zero claim amount' }) };
    }

    const totalLabour = isJobClaim ? claimRows.reduce((s, c) => s + c.labour_amount, 0) : Number(labourAmount) || 0;
    const totalMaterial = isJobClaim ? claimRows.reduce((s, c) => s + c.material_amount, 0) : Number(materialAmount) || 0;
    const totalStc = isJobClaim ? claimRows.reduce((s, c) => s + c.stc_amount, 0) : Number(stcAmount) || 0;
    const totalAmount = totalLabour + totalMaterial;

    let invoiceNumberStr = overrideNumber;
    if (!invoiceNumberStr) {
      const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
      if (numErr) throw numErr;
      const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
      invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
    }

    let overallClaimPercent = Number(claimPercent) || 100;
    let claimLabel = isJobClaim ? null : (description || null);
    if (isJobClaim) {
      const { data: allCentres } = await supabaseAdmin.from('cost_centres').select('quoted_amount').eq('project_id', projectId);
      const projectTotal = (allCentres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
      overallClaimPercent = projectTotal > 0 ? Math.round((totalAmount / projectTotal) * 10000) / 100 : null;

      // "Progress claim N" - N is how many non-deposit invoices this job
      // already has, +1. Counted in JS rather than a .neq() filter so a
      // null description (every progress claim raised before this label
      // existed) still correctly counts as "not the deposit", not gets
      // silently excluded by SQL's null != 'Deposit' => null semantics.
      const { data: priorInvoices } = await supabaseAdmin.from('invoices').select('description').eq('project_id', projectId);
      const priorProgressCount = (priorInvoices || []).filter(inv => inv.description !== 'Deposit').length;
      claimLabel = `Progress claim ${priorProgressCount + 1}`;
    }

    const invoiceToken = crypto.randomUUID();
    const invoiceDate = sentAt ? new Date(sentAt).toISOString() : new Date().toISOString();

    // Due date defaults from the client's own payment terms (COD unless
    // they're set up as net 7/14/30), but whoever's raising the invoice
    // can override it below.
    let dueDate = overrideDueDate || null;
    if (!dueDate) {
      const resolvedClientId = isJobClaim
        ? (await supabaseAdmin.from('projects').select('client_id').eq('id', projectId).single()).data?.client_id
        : clientId;
      const { data: client } = resolvedClientId
        ? await supabaseAdmin.from('clients').select('payment_terms').eq('id', resolvedClientId).maybeSingle()
        : { data: null };
      dueDate = computeDueDate(client?.payment_terms || 'cod', invoiceDate);
    }

    const { data: insertedInvoice, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert({
        project_id: isJobClaim ? projectId : null,
        cost_centre_id: null, // stage detail for job-linked claims always lives in invoice_claims now
        client_id: isJobClaim ? null : clientId,
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
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    if (isJobClaim) {
      const { error: claimsErr } = await supabaseAdmin
        .from('invoice_claims')
        .insert(claimRows.map(c => ({ ...c, invoice_id: insertedInvoice.id })));
      if (claimsErr) throw claimsErr;

      const { data: centresBefore } = await supabaseAdmin
        .from('cost_centres')
        .select('id, invoiced_amount')
        .in('id', claimRows.map(c => c.cost_centre_id));
      await Promise.all(claimRows.map(c => {
        const before = Number((centresBefore || []).find(cc => cc.id === c.cost_centre_id)?.invoiced_amount) || 0;
        return supabaseAdmin.from('cost_centres').update({ invoiced_amount: before + c.labour_amount + c.material_amount }).eq('id', c.cost_centre_id);
      }));
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
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
