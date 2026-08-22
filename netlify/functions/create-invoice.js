// POST /api/create-invoice
// Body EITHER: { costCentreId, labourAmount, materialAmount, stcAmount, claimPercent, invoiceNumber }
//   for a job-linked claim, OR
// { clientId, description, labourAmount, materialAmount, invoiceNumber }
//   for a standalone invoice with no job/quote behind it.
// Pricing roles only. Creates a new row in the invoices table.

const crypto = require('crypto');
const { requirePricingRole } = require('./_shared/require-pricing-role');

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
      costCentreId,
      clientId,
      description,
      labourAmount = 0,
      materialAmount = 0,
      stcAmount = 0,
      claimPercent = 100,
      invoiceNumber: overrideNumber,
    } = JSON.parse(event.body || '{}');

    if (!costCentreId && !clientId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Either costCentreId (job claim) or clientId (standalone invoice) is required' }) };
    }

    let invoicedAmountBefore = 0;
    if (costCentreId) {
      const { data: centre, error: centreErr } = await supabaseAdmin
        .from('cost_centres')
        .select('id, invoiced_amount')
        .eq('id', costCentreId)
        .single();
      if (centreErr || !centre) throw new Error('Cost centre not found');
      invoicedAmountBefore = Number(centre.invoiced_amount) || 0;
    }

    let invoiceNumberStr = overrideNumber;
    if (!invoiceNumberStr) {
      const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
      if (numErr) throw numErr;
      const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
      invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
    }

    const invoiceToken = crypto.randomUUID();
    const totalAmount = (Number(labourAmount) || 0) + (Number(materialAmount) || 0);

    const { data: insertedInvoice, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert({
        cost_centre_id: costCentreId || null,
        client_id: costCentreId ? null : clientId,
        description: costCentreId ? null : (description || null),
        invoice_number: invoiceNumberStr,
        invoice_token: invoiceToken,
        labour_amount: Number(labourAmount) || 0,
        material_amount: Number(materialAmount) || 0,
        stc_amount: Number(stcAmount) || 0,
        claim_percent: Number(claimPercent) || 100,
        created_by: user.id,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    if (costCentreId) {
      await supabaseAdmin
        .from('cost_centres')
        .update({ invoiced_amount: invoicedAmountBefore + totalAmount })
        .eq('id', costCentreId);
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
