// POST /api/create-payment-link
// Body: { invoiceId }
// Pricing roles only. Generates an Airwallex Payment Link for an
// already-created invoice (see create-invoice.js) - shown on the client
// invoice page alongside the bank transfer details. A `payment_link.paid`
// webhook auto-marks the invoice paid once the client actually pays it.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { airwallexRequest } = require('./_shared/airwallex-client');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!invoiceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required' }) };
    }

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('*, cost_centres(name, projects(job_number)), clients(name)')
      .eq('id', invoiceId)
      .single();
    if (invErr || !invoice) throw new Error('Invoice not found');
    if (invoice.airwallex_payment_link_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice already has a payment link.' }) };
    }

    const totalAmount = Number(invoice.labour_amount) + Number(invoice.material_amount) - Number(invoice.stc_amount || 0);
    if (totalAmount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to charge - this invoice totals zero or less after any STC credit.' }) };
    }

    const stageName = invoice.cost_centres?.name || invoice.description || 'Invoice';
    const jobNumber = invoice.cost_centres?.projects?.job_number;
    const title = jobNumber ? `Job ${jobNumber} - ${stageName}` : `${invoice.description || 'Invoice'} ${invoice.invoice_number}`;

    const result = await airwallexRequest('pa/payment_links/create', {
      method: 'POST',
      body: {
        amount: Math.round(totalAmount * 100) / 100,
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
        airwallex_payment_link_id: result.id,
        airwallex_payment_link_url: result.url,
      })
      .eq('id', invoiceId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: result.url }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
