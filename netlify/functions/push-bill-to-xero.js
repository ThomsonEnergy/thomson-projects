// POST /.netlify/functions/push-bill-to-xero
// Body: { bill_id }. Push to Xero on the supplier page (item 83 part C): one approved supplier bill or
// credit note to Xero now, as _shared/push-bill-to-xero.js does for the worker. Pricing roles (the same
// people who push invoices). The error from Xero, or the reason it cannot go yet (not approved, no
// account code in Settings > Xero Mapping), comes back in plain words.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { pushBillToXero } = require('./_shared/push-bill-to-xero');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin, user } = auth;
  try {
    const { bill_id: billId } = JSON.parse(event.body || '{}');
    if (!billId) return json(400, { ok: false, error: 'bill_id is required' });
    const r = await pushBillToXero(supabaseAdmin, billId, { actorId: user.id });
    return json(200, { ok: true, ...r });
  } catch (err) {
    console.error('push-bill-to-xero failed:', err.message);
    return json(400, { ok: false, error: err.message });
  }
};
