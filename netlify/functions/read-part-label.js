// POST /.netlify/functions/read-part-label
// Body: { fileBase64, mediaType } - a photo (image/jpeg, image/png, image/webp) of a part's label.
// Any active logged-in user (the guys scan parts on site). Reads the label with
// _shared/part-label-ai.js and answers { ok, label }. Nothing is saved: the Scan a part panel
// (js/stock-scan.js) shows the reading for a check, then saves through material_add_from_scan.

const { requireActiveUser } = require('./_shared/require-active-user');
const { readPartLabel } = require('./_shared/part-label-ai');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  try {
    const { fileBase64, mediaType } = JSON.parse(event.body || '{}');
    if (!fileBase64 || !IMAGE_TYPES.includes(mediaType)) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Send a photo (jpeg, png or webp).' }) };
    const label = await readPartLabel({ fileBase64, mediaType });
    return { statusCode: 200, body: JSON.stringify({ ok: true, label }) };
  } catch (err) {
    console.error('read-part-label failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Could not read the label. Try a closer, straighter photo.' }) };
  }
};
