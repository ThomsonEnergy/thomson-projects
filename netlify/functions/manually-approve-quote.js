// POST /.netlify/functions/manually-approve-quote
// Body: { quoteId, method: 'email' | 'phone' | 'in_person', note, emailThreadId }
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
    const { quoteId, method = 'phone', note, emailThreadId } = JSON.parse(event.body || '{}');
    if (!quoteId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'quoteId is required' }) };
    }
    if (!['email', 'phone', 'in_person'].includes(method)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Pick how the client approved it.' }) };
    }
    // With email the client's email is the proof (it must be tagged to the quote); otherwise a note is required.
    if (method === 'email') {
      if (!emailThreadId) return { statusCode: 400, body: JSON.stringify({ error: 'Pick the client\'s email.' }) };
      const { data: link } = await supabaseAdmin.from('email_job_links').select('id').eq('thread_id', emailThreadId).eq('project_id', quoteId).limit(1);
      if (!link || !link.length) return { statusCode: 400, body: JSON.stringify({ error: 'That email is not tagged to this quote. Tag it first, then pick it.' }) };
    } else if (!note || !note.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A note on how/when the client approved is required (e.g. "Approved by phone call, 28 Aug 2026").' }) };
    }
    const methodText = { email: 'Approved by email', phone: 'Approved by phone call', in_person: 'Approved in person' }[method];
    const approvalNote = note && note.trim() ? `${methodText}: ${note.trim()}` : methodText;

    const { jobId, jobNumber, invoiceToken } = await createJobFromQuote(supabaseAdmin, {
      quoteId, approvedBy: user.id, approvalNote,
    });
    await supabaseAdmin.from('projects').update({
      approval_method: method, approval_email_thread_id: method === 'email' ? emailThreadId : null,
      declined_at: null, declined_by: null, decline_reason: null, expired: false,
    }).eq('id', quoteId);
    return { statusCode: 200, body: JSON.stringify({ ok: true, jobId, jobNumber, invoiceToken }) };
  } catch (err) {
    console.error('manually-approve-quote error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
