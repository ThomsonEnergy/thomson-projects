// POST /.netlify/functions/accept-variation
// Body: { token, name, signature }  (token = the variation's own token, the one in
// quote.html?variation=<token>; signature = a PNG data URL drawn on the page)
//
// Public - no staff login, called from the client-facing variation page. Security
// comes from the random token, the same model as accept-quote.js.
//
// A fixed-price variation that has been sent to the client for signing becomes part
// of the job when they sign: it is added as a stage (cost centre) at the agreed
// price - so it is invoiced like any other stage, and shows on the quote - and a
// signed record goes into the job's variations history. Signing twice is harmless.

const { getAdminClient } = require('./_shared/require-admin');
const { approveVariation } = require('./_shared/approve-variation');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const supabaseAdmin = getAdminClient();

  try {
    const { token, name, signature } = JSON.parse(event.body || '{}');
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'token is required' }) };
    const signedName = String(name || '').trim();
    if (!signedName) return { statusCode: 400, body: JSON.stringify({ error: 'Please type your full name.' }) };
    // A plain PNG data URL only: it is shown in an <img> on the variation page and staff pages.
    if (typeof signature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 600000) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please draw your signature.' }) };
    }

    const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('*').eq('variation_token', token).eq('variation_type', 'fixed').maybeSingle();
    if (!entry || !['sent', 'approved'].includes(entry.approval_status)) {
      return { statusCode: 404, body: JSON.stringify({ error: 'This variation link is not valid or is no longer open for signing.' }) };
    }
    if (entry.approval_status === 'approved') return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyApproved: true }) };

    await approveVariation(supabaseAdmin, entry, { method: 'online', signedName, signature });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('accept-variation error:', err.message);
    return { statusCode: err.statusCode || 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
