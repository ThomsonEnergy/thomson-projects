// The site's own sun figures for a quote (backlog item 75). The savings estimate normally runs on
// an area figure (3.9 kWh a day from each kW around Sydney, 4.2 in Queensland and the Northern
// Rivers); with this the quote gets figures worked out from ten years of daily sun records for its
// own site: the yearly sun figure, the seasons, and how many days are dull. Nobody presses
// anything: it runs by itself when a draft quote's bill card opens and whenever the address is
// saved, and does nothing when the quote already has figures for its address.
//
// A quote already sent is left alone: the client has its figures, and they should not move
// because someone opened the quote or saved something else on it. It only moves when its address
// changes (the old figures no longer fit then). New quotes and copies start as drafts, so they
// get the records.
//
// Who calls it: project.html, as ensureSiteSun({ project, onReady }) from wireBillCard, and
// ensureSiteSun() (no arguments: the quote on the page again) after the quote and client card is
// saved.
// What it reads: the Places library already on the quote page, only to turn the address into a
// spot on the map when the Pylon site has none.
// What it writes: nothing itself. netlify/functions/site-sun.js saves projects.site_sun (with lat
// and lng); this copies the answer onto the project in hand and calls onReady so the estimate
// redraws. Any failure is quiet: the estimate keeps the area figure and the Savings assumptions
// panel says there are no sun records for the site yet.

let siteSunWatch = null;        // { project, onReady } for the quote on the page (the page redraws: always the newest)
let siteSunSeen = null;         // { id, address }: the quote's address when it was last looked at here
const siteSunBusy = new Set();  // "<quote id>|<address>" being fetched, so two calls do not overlap

// The address as a spot on the map, or null. Only an address that ends on a postcode is looked
// up, and only a match in that postcode is taken, so a short address never lands in another town.
// Waits up to ten seconds for the Places library the quote page loads for its address box (never
// loads it itself) and gives the lookup eight seconds.
async function siteSunLookUp(address) {
  const postcode = (address.match(/\b(\d{4})(?:\s*,?\s*Australia)?\s*$/i) || [])[1];
  if (!postcode) return null;
  for (let i = 0; i < 40 && !(window.google && google.maps && google.maps.places); i++) await new Promise(r => setTimeout(r, 250));
  const places = window.google && google.maps && google.maps.places;
  if (!places) return null;
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), 8000);
    try {
      new places.AutocompleteService().getPlacePredictions({ input: address, componentRestrictions: { country: 'au' } }, (list, status) => {
        const first = status === 'OK' && (list || [])[0];
        if (!first) { resolve(null); return; }
        new places.PlacesService(document.createElement('div')).getDetails({ placeId: first.place_id, fields: ['geometry', 'address_components'] }, (place, st) => {
          const at = st === 'OK' && place && place.geometry && place.geometry.location;
          const found = ((place && place.address_components) || []).find(c => (c.types || []).includes('postal_code'));
          resolve(at && found && found.long_name === postcode ? { lat: at.lat(), lng: at.lng() } : null);
        });
      });
    } catch (err) { resolve(null); }
  });
}

async function ensureSiteSun(opts) {
  if (opts) siteSunWatch = opts;
  if (!siteSunWatch) return;
  const project = siteSunWatch.project;
  const address = String(project.client_address || '').trim();
  // a quote already sent only moves when its address changed: here just now, or since its figures were worked out
  const changed = !!siteSunSeen && siteSunSeen.id === project.id && siteSunSeen.address !== address;
  const stale = !!project.site_sun && project.site_sun.for_address !== address;
  siteSunSeen = { id: project.id, address };
  if (project.status !== 'draft' && !changed && !stale) return;
  if (!project.id || !address) return;
  if (project.site_sun && project.site_sun.for_address === address) return;
  const key = `${project.id}|${address}`;
  if (siteSunBusy.has(key)) return;
  siteSunBusy.add(key);
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
    // the page may have been redrawn (a fresh project object) or the address changed while this
    // ran: the figures go on the quote now on the page, and only when they are for its address
    const now = siteSunWatch;
    if (now.project.id !== project.id || String(now.project.client_address || '').trim() !== out.site_sun.for_address) return;
    now.project.site_sun = out.site_sun;
    if (now.onReady) now.onReady(out.site_sun);
  } catch (err) {
    console.error('site sun:', err.message);
  } finally {
    siteSunBusy.delete(key);
  }
}
