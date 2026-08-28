// POST /.netlify/functions/accept-quote
// Body: { token }  (the quote's own token, same one quote.html reads from
// its URL and passes to get_quote_by_token/accept_quote)
//
// Public - no staff login, called straight from the client-facing quote
// page. Security comes from the same random token model already used to
// view the quote at all, not from authentication.
//
// Runs the existing accept_quote RPC (unchanged - whatever numbering/
// status logic it already has keeps happening exactly as before), then,
// if this quote has a deposit due on acceptance, raises that deposit as a
// real invoice straight away and hands back its token so the client can
// be sent directly to their invoice/payment page - rather than accepting
// and then having no way to actually pay until a staff member gets to it.
//
// The deposit is distributed across every cost centre in proportion to
// its share of the quote, same as invoicing a % of the whole project from
// the job page - so each stage's invoiced_amount already reflects the
// deposit, and the first real stage claim later won't double-charge it.

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/require-admin');

function splitLabourMaterial(centre, amount) {
  const labourCost = Number(centre.estimated_labour_cost) || 0;
  const materialCost = Number(centre.estimated_material_cost) || 0;
  const costTotal = labourCost + materialCost;
  const labourShare = costTotal > 0 ? labourCost / costTotal : 1;
  const labourAmount = Math.round(amount * labourShare * 100) / 100;
  const materialAmount = Math.round((amount - labourAmount) * 100) / 100;
  return { labourAmount, materialAmount };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const supabaseAdmin = getAdminClient();

  try {
    const { token } = JSON.parse(event.body || '{}');
    if (!token) {
      return { statusCode: 400, body: JSON.stringify({ error: 'token is required' }) };
    }

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('projects')
      .select('id, status, deposit_percent, proposal_template')
      .eq('quote_token', token)
      .maybeSingle();
    if (beforeErr || !before) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Quote not found' }) };
    }
    const wasAlreadyAccepted = ['accepted', 'in_progress', 'complete'].includes(before.status);

    if (!wasAlreadyAccepted) {
      const { error: acceptErr } = await supabaseAdmin.rpc('accept_quote', { p_token: token });
      if (acceptErr) throw acceptErr;
    }

    const hasDeposit = (Number(before.deposit_percent) || 0) > 0
      && before.proposal_template !== 'quick_estimate'
      && before.proposal_template !== 'time_and_materials';
    if (!hasDeposit) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceToken: null }) };
    }

    // Idempotent: if this quote was already accepted (a re-click, or the
    // page reloading before the client saw the redirect), reuse the
    // deposit invoice already raised rather than creating a second one.
    const { data: existing } = await supabaseAdmin
      .from('invoices')
      .select('invoice_token')
      .eq('project_id', before.id)
      .eq('description', 'Deposit')
      .maybeSingle();
    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceToken: existing.invoice_token }) };
    }

    const { data: centres, error: centresErr } = await supabaseAdmin
      .from('cost_centres')
      .select('id, quoted_amount, estimated_labour_cost, estimated_material_cost')
      .eq('project_id', before.id);
    if (centresErr) throw centresErr;

    const totalQuoted = (centres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
    if (!(totalQuoted > 0)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceToken: null }) };
    }

    const depositPercent = Number(before.deposit_percent) || 0;
    const depositTotal = Math.round(totalQuoted * (depositPercent / 100) * 100) / 100;

    const claimRows = (centres || [])
      .map(c => {
        const share = Number(c.quoted_amount) / totalQuoted;
        const amount = Math.round(depositTotal * share * 100) / 100;
        const { labourAmount, materialAmount } = splitLabourMaterial(c, amount);
        return { cost_centre_id: c.id, labour_amount: labourAmount, material_amount: materialAmount, stc_amount: 0, claim_percent: depositPercent };
      })
      .filter(c => c.labour_amount + c.material_amount > 0);
    if (!claimRows.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceToken: null }) };
    }

    const totalLabour = claimRows.reduce((s, c) => s + c.labour_amount, 0);
    const totalMaterial = claimRows.reduce((s, c) => s + c.material_amount, 0);

    const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
    if (numErr) throw numErr;
    const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
    const invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
    const invoiceToken = crypto.randomUUID();

    const { data: insertedInvoice, error: insErr } = await supabaseAdmin
      .from('invoices')
      .insert({
        project_id: before.id,
        cost_centre_id: null,
        client_id: null,
        description: 'Deposit',
        invoice_number: invoiceNumberStr,
        invoice_token: invoiceToken,
        labour_amount: totalLabour,
        material_amount: totalMaterial,
        stc_amount: 0,
        claim_percent: depositPercent,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    const { error: claimsErr } = await supabaseAdmin
      .from('invoice_claims')
      .insert(claimRows.map(c => ({ ...c, invoice_id: insertedInvoice.id })));
    if (claimsErr) throw claimsErr;

    const { data: centresBefore } = await supabaseAdmin
      .from('cost_centres')
      .select('id, invoiced_amount')
      .in('id', claimRows.map(c => c.cost_centre_id));
    await Promise.all(claimRows.map(c => {
      const beforeAmt = Number((centresBefore || []).find(cc => cc.id === c.cost_centre_id)?.invoiced_amount) || 0;
      return supabaseAdmin.from('cost_centres').update({ invoiced_amount: beforeAmt + c.labour_amount + c.material_amount }).eq('id', c.cost_centre_id);
    }));

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceToken }) };
  } catch (err) {
    console.error('accept-quote error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
