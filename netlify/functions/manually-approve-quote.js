// POST /.netlify/functions/manually-approve-quote
// Body: { quoteId, note }
// Pricing roles only. For approvals that didn't happen through the
// client clicking "Approve" on their own quote page - a phone call, an
// email, a signature collected in person. Requires a note (e.g. "Approved
// by phone call with Jane, 28 Aug 2026") so there's a record of how and
// when consent was actually given, since there's no client click to point
// to. Does exactly what the online path does otherwise - see
// _shared/create-job-from-quote.js.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { createJobFromQuote } = require('./_shared/create-job-from-quote');

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
    const { quoteId, note } = JSON.parse(event.body || '{}');
    if (!quoteId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'quoteId is required' }) };
    }
    if (!note || !note.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A note on how/when the client approved is required (e.g. "Approved by phone call, 28 Aug 2026").' }) };
    }

    const { jobId, jobNumber, invoiceToken } = await createJobFromQuote(supabaseAdmin, {
      quoteId, approvedBy: user.id, approvalNote: note.trim(),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, jobId, jobNumber, invoiceToken }) };
  } catch (err) {
    console.error('manually-approve-quote error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
