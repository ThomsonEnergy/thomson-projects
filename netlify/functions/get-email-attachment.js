const { requireActiveUser } = require('./_shared/require-active-user');
const { gmailRequest } = require('./_shared/google-client');

// POST { email_id, part_id } - returns one attachment (or inline image) of an email in
// the shared inbox as base64, fetched from Gmail on demand. Signed-in staff only.
// Netlify caps a response at about 6 MB, so anything over roughly 4 MB is refused with a
// clear message (open it in Gmail instead).

const MAX_BYTES = 4 * 1024 * 1024;
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

function findPart(payload, partId) {
  if (!payload) return null;
  if ((payload.partId || null) === partId && (payload.body?.attachmentId || payload.body?.data)) return payload;
  for (const p of payload.parts || []) {
    const hit = findPart(p, partId);
    if (hit) return hit;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  try {
    const { email_id: emailId, part_id: partId } = JSON.parse(event.body || '{}');
    if (!emailId || partId === undefined || partId === null) return json(400, { ok: false, error: 'email_id and part_id are required.' });
    const { data: email } = await auth.supabaseAdmin.from('emails').select('gmail_message_id, attachments').eq('id', emailId).maybeSingle();
    if (!email) return json(404, { ok: false, error: 'Email not found.' });
    // only things we listed for this email can be asked for
    const listed = (email.attachments || []).find(a => String(a.part_id) === String(partId));
    if (!listed) return json(404, { ok: false, error: 'That attachment is not on this email.' });
    if (listed.size > MAX_BYTES) return json(413, { ok: false, error: 'This file is too big to open here. Open the email in Gmail to get it.' });

    const msg = await gmailRequest(`messages/${email.gmail_message_id}?format=full`);
    const part = findPart(msg.payload, String(partId));
    if (!part) return json(404, { ok: false, error: 'That attachment is no longer in Gmail.' });
    let b64url = part.body.data;
    if (!b64url) {
      const att = await gmailRequest(`messages/${email.gmail_message_id}/attachments/${part.body.attachmentId}`);
      b64url = att.data;
    }
    if (!b64url) return json(404, { ok: false, error: 'Gmail returned an empty file.' });
    const data = b64url.replace(/-/g, '+').replace(/_/g, '/');
    if (data.length * 0.75 > MAX_BYTES) return json(413, { ok: false, error: 'This file is too big to open here. Open the email in Gmail to get it.' });
    return json(200, { ok: true, name: listed.name, mime: listed.mime || part.mimeType || 'application/octet-stream', data });
  } catch (err) {
    console.error('get-email-attachment failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
