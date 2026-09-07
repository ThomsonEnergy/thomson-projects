// GET /.netlify/functions/run-supplier-payments
// Preview only - which approved, unpaid supplier bills are due today or
// earlier, grouped by supplier, with a running total and whether bank
// details are on file for them. Admin/finance only.
//
// POST here (the "Confirm & send to Airwallex" step in suppliers.html)
// deliberately does NOT create anything in Airwallex - that part of this
// feature was designed on the frontend (the preview/confirm UI, the
// supplier_payments table with its airwallex_transfer_id/status columns)
// but the actual payout-creation code was never built. Sending real
// money via an API surface (Airwallex Beneficiaries/Payouts, a different
// product from the payment-links already used for client invoices) needs
// a dedicated, carefully-tested implementation against Airwallex's own
// docs - not a guess with no way to verify it against a live response,
// unlike this app's Xero integration work. Returns a clear "not
// available yet" error instead of pretending to send anything.

const { requireFinanceRole } = require('./_shared/require-finance-role');

exports.handler = async (event) => {
  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  if (event.httpMethod === 'POST') {
    return {
      statusCode: 501,
      body: JSON.stringify({
        ok: false,
        error: "Sending payments to Airwallex isn't built yet - pay these manually (bank transfer or Airwallex) for now, then mark each bill paid from the supplier's own page.",
      }),
    };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: bills, error } = await supabaseAdmin
      .from('supplier_bills')
      .select('id, amount, supplier_id, suppliers(name, bank_account_number)')
      .eq('paid', false)
      .eq('approved_for_payment', true)
      .not('due_date', 'is', null)
      .lte('due_date', today)
      .not('supplier_id', 'is', null);
    if (error) throw error;

    const bySupplier = {};
    (bills || []).forEach(b => {
      const sid = b.supplier_id;
      if (!bySupplier[sid]) {
        bySupplier[sid] = { supplierName: b.suppliers?.name || 'Unknown', billCount: 0, total: 0, hasBankDetails: !!b.suppliers?.bank_account_number };
      }
      bySupplier[sid].billCount += 1;
      bySupplier[sid].total += Number(b.amount) || 0;
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, preview: Object.values(bySupplier) }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
