// POST /.netlify/functions/cut-out-picture
// Body: { check: true }  or  { image: '<base64 JPEG or PNG>' }
// Pricing roles (the picture editor on a quote, js/photo-compose.js). Cuts the equipment out of a
// picture: sends the picture to the cut-out service and returns it with the background made
// see-through, as { ok, png: '<base64 PNG>' }. The editor only uses the outline of what comes
// back; the picture itself stays the staff's own.
//
// The service is Photoroom's Remove Background API (about 2 US cents a picture on its Basic plan,
// checked 12 Nov 2026). Its key lives in api_keys as "photoroom" (Settings > API Keys). With no key
// the editor's "Cut out automatically" button is left out and the hand tools (Trace, Box, Rub
// out, Bring back) do the job: { check: true } answers { ok, available } so the page knows.
//
// What leaves the app: the one picture the person is cutting out (a product shot or an install
// picture), nothing else: no quote, client or job details. Nothing is stored here.
//
// NOTE: written from Photoroom's API pages (docs.photoroom.com), not yet run against the real
// service: the first run with a key is the test.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { getIntegrationKey } = require('./_shared/get-integration-key');

const SERVICE_URL = 'https://sdk.photoroom.com/v1/segment';
const MAX_IN = 4 * 1024 * 1024;   // the picture sent, in bytes
const MAX_OUT = 4 * 1024 * 1024;  // the cut-out that comes back (a function's answer tops out near 6 MB)

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    let key = null;
    try { key = await getIntegrationKey('photoroom'); } catch (err) { key = null; }
    if (body.check) return json(200, { ok: true, available: !!key });
    if (!key) return json(200, { ok: false, error: 'The automatic cut-out is not set up. Cut it out by hand with Trace, or add the Photoroom key in Settings, API Keys.' });

    const picture = Buffer.from(String(body.image || ''), 'base64');
    if (picture.length < 200 || picture.length > MAX_IN || !(isJpeg(picture) || isPng(picture))) return json(400, { ok: false, error: 'That picture could not be read.' });

    const form = new FormData();
    form.append('image_file', new Blob([picture], { type: isPng(picture) ? 'image/png' : 'image/jpeg' }), isPng(picture) ? 'picture.png' : 'picture.jpg');
    form.append('format', 'png');
    const res = await fetch(SERVICE_URL, { method: 'POST', headers: { 'x-api-key': key, Accept: 'image/png, application/json' }, body: form, signal: AbortSignal.timeout(25000) });
    if (!res.ok) {
      console.error('cut-out-picture: the service answered', res.status, (await res.text().catch(() => '')).slice(0, 300));
      const why = res.status === 401 || res.status === 403 ? 'The cut-out service refused the key. Check it in Settings, API Keys.'
        : res.status === 402 ? 'The cut-out service says the account is out of credit.'
          : 'The cut-out service could not do this picture. Cut it out by hand with Trace.';
      return json(200, { ok: false, error: why });
    }
    const cut = Buffer.from(await res.arrayBuffer());
    if (!isPng(cut) || cut.length > MAX_OUT) {
      console.error('cut-out-picture: an answer this code does not know', res.headers.get('content-type'), cut.length);
      return json(200, { ok: false, error: 'The cut-out service sent back something unexpected. Cut it out by hand with Trace.' });
    }
    return json(200, { ok: true, png: cut.toString('base64') });
  } catch (err) {
    console.error('cut-out-picture failed:', err.message);
    return json(200, { ok: false, error: 'The automatic cut-out did not answer. Cut it out by hand with Trace.' });
  }
};
