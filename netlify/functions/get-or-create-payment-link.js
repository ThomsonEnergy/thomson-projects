// POST /.netlify/functions/get-or-create-payment-link
// Body: { token }
// Public - no staff login involved, this is called by the client from
// the invoice page itself. Security comes from the same random-UUID
// token model already used for viewing the invoice at all (see
// get_invoice_by_token_v2), not from authentication.
//
// Creates the Airwallex payment link the first time it's actually needed
// - when the client clicks "Pay online" - rather than at invoice creation
// time. Two reasons: the amount is computed fresh at the moment of the
// click via get_invoice_balance_due(), so it can never go stale even if
// something about the invoice changes later; and no Airwallex object
// ever gets created for a client who just pays by bank transfer and
// never clicks the button.
//
// If a link already exists for this invoice (a second click, or the
// client re-opening the page later), the existing one is returned as-is
// rather than creating a duplicate.

const { getAdminClient } = require('./_shared/require-admin');
const { airwallexRequest } = require('./_shared/airwallex-client');

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

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, description, paid_at, airwallex_payment_link_url, cost_centres(name, projects(job_number))')
      .eq('invoice_token', token)
      .maybeSingle();
    if (invErr || !invoice) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Invoice not found' }) };
    }
    if (invoice.paid_at) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice is already paid.' }) };
    }

    // Already generated on an earlier click - just hand back the same one.
    if (invoice.airwallex_payment_link_url) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, url: invoice.airwallex_payment_link_url }) };
    }

    const { data: amount, error: balanceErr } = await supabaseAdmin.rpc('get_invoice_balance_due', { p_invoice_id: invoice.id });
    if (balanceErr) throw balanceErr;
    if (Number(amount) <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to charge on this invoice.' }) };
    }

    const stageName = invoice.cost_centres?.name || invoice.description || 'Invoice';
    const jobNumber = invoice.cost_centres?.projects?.job_number;
    const title = jobNumber ? `Job ${jobNumber} - ${stageName}` : `${invoice.description || 'Invoice'} ${invoice.invoice_number}`;

    const linkResult = await airwallexRequest('pa/payment_links/create', {
      method: 'POST',
      body: {
        amount: Math.round(Number(amount) * 100) / 100,
        currency: 'AUD',
        title,
        reusable: false,
        reference: invoice.invoice_number,
        description: `Invoice ${invoice.invoice_number}`,
      },
    });

    await supabaseAdmin
      .from('invoices')
      .update({
        airwallex_payment_link_id: linkResult.id,
        airwallex_payment_link_url: linkResult.url,
      })
      .eq('id', invoice.id);

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: linkResult.url }) };
  } catch (err) {
    console.error('get-or-create-payment-link error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Online payment isn\'t available right now - please use the bank details on this invoice instead.' }) };
  }
};
