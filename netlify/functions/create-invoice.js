// POST /api/create-invoice
// Body: { costCentreId, labourAmount, materialAmount, stcAmount, claimPercent, invoiceNumber (optional override) }
// Pricing roles only. Creates a new row in the invoices table - a stage
// can be claimed more than once, so this always adds a new claim rather
// than overwriting a single invoice per stage.

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
      labourAmount = 0,
      materialAmount = 0,
      stcAmount = 0,
      claimPercent = 100,
      invoiceNumber: overrideNumber,
    } = JSON.parse(event.body || '{}');

    if (!costCentreId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'costCentreId is required' }) };
    }

    const { data: centre, error: centreErr } = await supabaseAdmin
      .from('cost_centres')
      .select('id, invoiced_amount')
      .eq('id', costCentreId)
      .single();
    if (centreErr || !centre) throw new Error('Cost centre not found');

    let invoiceNumberStr = overrideNumber;
    if (!invoiceNumberStr) {
      const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number', { counter_name: 'invoice' });
      if (numErr) throw numErr;
      const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
      invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
    }

    const invoiceToken = crypto.randomUUID();
    const totalAmount = (Number(labourAmount) || 0) + (Number(materialAmount) || 0);

    const { error: insErr } = await supabaseAdmin.from('invoices').insert({
      cost_centre_id: costCentreId,
      invoice_number: invoiceNumberStr,
      invoice_token: invoiceToken,
      labour_amount: Number(labourAmount) || 0,
      material_amount: Number(materialAmount) || 0,
      stc_amount: Number(stcAmount) || 0,
      claim_percent: Number(claimPercent) || 100,
      created_by: user.id,
    });
    if (insErr) throw insErr;

    await supabaseAdmin
      .from('cost_centres')
      .update({ invoiced_amount: (Number(centre.invoiced_amount) || 0) + totalAmount })
      .eq('id', costCentreId);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, invoiceNumber: invoiceNumberStr, invoiceToken }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
