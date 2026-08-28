// POST /.netlify/functions/accept-quote
// Body: { token }  (the quote's own token, same one quote.html reads from
// its URL)
//
// Public - no staff login, called straight from the client-facing quote
// page. Security comes from the same random token model already used to
// view the quote at all, not from authentication.
//
// The quote itself is frozen as an approved historical record (status:
// 'approved', approved_at stamped) and stays exactly as sent - it never
// becomes the job. A brand new project row is created as the job (its
// own job number, its own copy of every stage), which is what actually
// gets invoiced/varied/scheduled from here on - see
// _shared/create-job-from-quote.js. If the quote has a deposit due, it's
// raised as a real invoice against the new job immediately, and the
// client is sent straight there.

const { getAdminClient } = require('./_shared/require-admin');
const { createJobFromQuote } = require('./_shared/create-job-from-quote');

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

    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from('projects')
      .select('id, status')
      .eq('quote_token', token)
      .maybeSingle();
    if (quoteErr || !quote) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Quote not found' }) };
    }

    const { jobNumber, invoiceToken } = await createJobFromQuote(supabaseAdmin, { quoteId: quote.id });
    return { statusCode: 200, body: JSON.stringify({ ok: true, jobNumber, invoiceToken }) };
  } catch (err) {
    console.error('accept-quote error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
