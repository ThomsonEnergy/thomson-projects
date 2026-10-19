// POST /.netlify/functions/accept-quote
// Body: { token, name?, signature? }  (the quote's own token, same one quote.html reads
// from its URL; name + signature = the client's typed name and drawn signature PNG, kept
// on the quote as proof of who accepted it)
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
const { startFinalizeDocuments } = require('./_shared/start-finalize-documents');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const supabaseAdmin = getAdminClient();

  try {
    const { token, name, signature } = JSON.parse(event.body || '{}');
    if (!token) {
      return { statusCode: 400, body: JSON.stringify({ error: 'token is required' }) };
    }

    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from('projects')
      .select('id, status, job_number')
      .eq('quote_token', token)
      .maybeSingle();
    // A job's own token (a Direct Job's, shown on its variation pages) is not a quote to accept.
    if (quoteErr || !quote || quote.job_number) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Quote not found' }) };
    }

    if (quote.status === 'declined') {
      return { statusCode: 400, body: JSON.stringify({ error: 'This quote was declined. Please contact us if you would like to go ahead.' }) };
    }

    // Keep the signature on the quote itself (the frozen approved record).
    // Only a plain PNG data URL is kept (it is shown in an <img>), and an approved quote's
    // signature is never replaced by a second signing.
    const signedName = String(name || '').trim().slice(0, 200);
    if (quote.status !== 'approved' && signedName && typeof signature === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) && signature.length <= 600000) {
      await supabaseAdmin.from('projects').update({ accepted_signed_by_name: signedName, accepted_signature_data_url: signature }).eq('id', quote.id);
    }

    const { jobId, jobNumber, invoiceToken } = await createJobFromQuote(supabaseAdmin, { quoteId: quote.id });
    if (quote.status !== 'approved') await supabaseAdmin.from('projects').update({ approval_method: 'online' }).eq('id', quote.id);
    // The signed quote becomes the job's quote PDF (made in the background).
    if (quote.status !== 'approved') await startFinalizeDocuments({ kind: 'quote_accepted', quoteId: quote.id, jobId });

    return { statusCode: 200, body: JSON.stringify({ ok: true, jobNumber, invoiceToken }) };
  } catch (err) {
    console.error('accept-quote error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
