// The site's own sun figures for a quote (backlog item 75). The savings estimate normally runs on
// an area figure (3.9 kWh a day from each kW around Sydney, 4.2 in Queensland and the Northern
// Rivers); with this the quote gets figures worked out from ten years of daily sun records for its
// own site: the yearly sun figure, the seasons, and how many days are dull. Nobody presses
// anything: it runs by itself when the quote's bill card opens and again when the address is
// saved, and does nothing when the quote already has figures for its address.
//
// Who calls it: project.html, as ensureSiteSun({ project, onReady }) from wireBillCard, and
// ensureSiteSun() (no arguments: the same quote again) after the address is saved.
// What it reads: the Places library already on the quote page, only to turn the address into a
// spot on the map when the Pylon design has none.
// What it writes: nothing itself. netlify/functions/site-sun.js saves projects.site_sun (with lat
// and lng); this copies the answer onto the project in hand and calls onReady so the estimate
// redraws. Any failure is quiet: the estimate keeps the area figure and the Savings assumptions
// panel says there are no sun records for the site yet.

let siteSunWatch = null;   // { project, onReady } for the quote on the page
let siteSunBusyFor = null; // the address being fetched, so two calls do not overlap

// The address as a spot on the map, or null. Waits up to ten seconds for the Places library the
// quote page loads for its address box; never loads it itself.
async function siteSunLookUp(address) {
  for (let i = 0; i < 40 && !(window.google && google.maps && google.maps.places); i++) await new Promise(r => setTimeout(r, 250));
  const places = window.google && google.maps && google.maps.places;
  if (!places) return null;
  return new Promise((resolve) => {
    try {
      new places.AutocompleteService().getPlacePredictions({ input: address, componentRestrictions: { country: 'au' } }, (list, status) => {
        const first = status === 'OK' && (list || [])[0];
        if (!first) { resolve(null); return; }
        new places.PlacesService(document.createElement('div')).getDetails({ placeId: first.place_id, fields: ['geometry'] }, (place, st) => {
          const at = st === 'OK' && place && place.geometry && place.geometry.location;
          resolve(at ? { lat: at.lat(), lng: at.lng() } : null);
        });
      });
    } catch (err) { resolve(null); }
  });
}

async function ensureSiteSun(opts) {
  if (opts) siteSunWatch = opts;
  if (!siteSunWatch) return;
  const { project, onReady } = siteSunWatch;
  const address = String(project.client_address || '').trim();
  if (!project.id || !address || siteSunBusyFor === address) return;
  if (project.site_sun && project.site_sun.for_address === address) return;
  siteSunBusyFor = address;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;
    const ask = async (body) => {
      const res = await fetch('/.netlify/functions/site-sun', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
      return res.json().catch(() => ({}));
    };
    let out = await ask({ projectId: project.id });
    if (out.ok && out.need_location) {
      const spot = await siteSunLookUp(address);
      if (!spot) return;
      out = await ask({ projectId: project.id, lat: spot.lat, lng: spot.lng });
    }
    if (!out.ok || !out.site_sun) return;
    // the address may have been changed while this ran: the figures only count for the one they are for
    if (out.site_sun.for_address !== String(project.client_address || '').trim()) return;
    project.site_sun = out.site_sun;
    if (onReady) onReady(out.site_sun);
  } catch (err) {
    console.error('site sun:', err.message);
  } finally {
    siteSunBusyFor = null;
  }
}
