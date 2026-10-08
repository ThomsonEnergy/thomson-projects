// GET /.netlify/functions/preview-email-signature
// Any active staff member. Returns the HTML of their own signature,
// built by exactly the same code send-gmail.js uses, so the preview in
// Settings > My Profile is what the client will actually receive.

const { requireActiveUser } = require('./_shared/require-active-user');
const { signatureForUser } = require('./_shared/build-email-signature');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }
  try {
    const { html } = await signatureForUser(auth.supabaseAdmin, auth.user);
    return { statusCode: 200, body: JSON.stringify({ ok: true, html }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
