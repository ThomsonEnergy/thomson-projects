// POST /.netlify/functions/read-supplier-quote   Body: { quote_id }
// Pricing roles. Reads a supplier's quote on file (Tally, _shared/supplier-quote-intake.js
// readSupplierQuote) now: the Supplier quotes tab calls it after Attach a supplier's quote, and
// from Read again on a quote that could not be read. The mailbox worker reads the ones that arrive
// by email on its own. Answers { ok, lines, total } or { ok: false, error }.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { readSupplierQuote } = require('./_shared/supplier-quote-intake');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { quote_id: quoteId } = JSON.parse(event.body || '{}');
  if (!UUID.test(String(quoteId || ''))) return json(400, { ok: false, error: 'Which quote?' });
  const admin = auth.supabaseAdmin;
  const { data: q } = await admin.from('supplier_quotes').select('id, status').eq('id', quoteId).maybeSingle();
  if (!q) return json(404, { ok: false, error: 'Supplier quote not found' });
  if (q.status === 'approved' || q.status === 'denied') return json(400, { ok: false, error: 'This quote is already decided.' });
  try {
    const result = await readSupplierQuote(admin, quoteId, { input_tokens: 0, output_tokens: 0 });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('read-supplier-quote failed:', err.message);
    // still a quote in: Approve makes an open PO and the bill fills in the lines
    await admin.from('supplier_quotes').update({ status: 'quoted', read_error: `Could not be read: ${String(err.message).slice(0, 160)}` }).eq('id', quoteId).eq('status', 'reading');
    return json(500, { ok: false, error: err.message });
  }
};
