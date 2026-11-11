// POST /.netlify/functions/site-sun
// Body: { projectId, lat?, lng? }
// Pricing roles (the quote page's bill card calls it by itself, js/site-sun.js). Works out the
// sun figures for a quote's own site from ten years of daily sun records (_shared/sun-climate.js)
// and saves them on the quote (projects.site_sun, with projects.lat and lng), where the savings
// estimate reads them on the quote page and on the client's proposal.
//
// Where the site is, in this order: the lat and lng sent (the browser looked the address up), the
// Pylon design's own site location (_shared/pylon-location.js), then the lat and lng saved before
// when the address has not changed. With none of those it answers { ok, need_location: true } and
// the browser looks the address up and calls again. Answers { ok, site_sun } or { ok: false, error }
// (nothing saved, and the estimate keeps its zone figure).

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { siteSunFor } = require('./_shared/sun-climate');
const { pylonSiteLocation, inAustralia } = require('./_shared/pylon-location');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    if (!/^[0-9a-f-]{36}$/i.test(String(body.projectId || ''))) return json(400, { ok: false, error: 'Which quote?' });
    const admin = auth.supabaseAdmin;
    const { data: project, error } = await admin.from('projects').select('id, client_address, lat, lng, pylon_project_id, site_sun').eq('id', body.projectId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!project) return json(404, { ok: false, error: 'Quote not found' });
    const address = String(project.client_address || '').trim();

    let place = null, from = null;
    const lat = Number(body.lat), lng = Number(body.lng);
    if (body.lat != null && body.lng != null && inAustralia(lat, lng)) { place = { lat, lng }; from = 'address'; }
    if (!place) { place = await pylonSiteLocation(project.pylon_project_id); if (place) from = 'pylon'; }
    if (!place && project.lat != null && project.lng != null && (project.site_sun || {}).for_address === address) { place = { lat: Number(project.lat), lng: Number(project.lng) }; from = (project.site_sun || {}).from || 'address'; }
    if (!place) return json(200, { ok: true, need_location: true });

    const sun = await siteSunFor(admin, place.lat, place.lng);
    const siteSun = { ...sun, for_address: address, from, at: new Date().toISOString() };
    const { error: saveErr } = await admin.from('projects').update({ lat: place.lat, lng: place.lng, site_sun: siteSun }).eq('id', project.id);
    if (saveErr) throw new Error(saveErr.message);
    return json(200, { ok: true, site_sun: siteSun });
  } catch (err) {
    console.error('site-sun failed:', err.message);
    return json(500, { ok: false, error: 'The sun records for this site could not be fetched just now.' });
  }
};
