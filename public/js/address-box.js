// The one address box for the whole app (item 103). Any page that takes a street address calls
//   wireAddressBox(input)          Google's Australian address suggestions on that input
//   await addressBoxParts(input)   the address in parts for what is in the box now, or null
// A picked suggestion fills the box and keeps its parts: { unit, street_number, street_name,
// street_type, suburb, state, postcode, lat, lng, place_id, formatted }. Text typed without picking
// is looked up by itself when the box is left, and its parts are kept only when Google's answer has
// the same street number and postcode, so a typed address never lands on the wrong house. An address
// Google does not know stays as typed, with no parts.
// The caller saves the parts beside the line of text (address_parts, lat, lng); nothing here writes.
// The key is Google's browser key from Company Details: staff pages get it from the database
// (google_maps_browser_key), a page with no login sets window.ADDRESS_BOX_KEY before calling.

let addressMapsReady = null;

function addressMaps() {
  if (addressMapsReady) return addressMapsReady;
  addressMapsReady = (async () => {
    if (window.google && google.maps && google.maps.places) return google.maps.places;
    let key = window.ADDRESS_BOX_KEY || '';
    if (!key && typeof supabaseClient !== 'undefined') {
      const { data } = await supabaseClient.rpc('google_maps_browser_key');
      key = data || '';
    }
    if (!key) return null;   // no key in Company Details yet: the box is plain typing
    await new Promise((ok) => {
      // another script on the page may be loading the same library (the old tag id is kept so it loads once)
      if (document.getElementById('google-places-script')) { ok(); return; }
      window._addressBoxMapsLoaded = ok;
      const s = document.createElement('script');
      s.id = 'google-places-script';
      s.async = true;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=_addressBoxMapsLoaded`;
      s.onerror = ok;
      document.head.appendChild(s);
    });
    for (let i = 0; i < 40 && !(window.google && google.maps && google.maps.places); i++) await new Promise(r => setTimeout(r, 250));
    return (window.google && google.maps && google.maps.places) || null;
  })();
  return addressMapsReady;
}

// Google's answer for one place, as the parts the app keeps. "Kendall Street" is split into the
// street's name and its type; a road with one word ("Broadway") has no type.
function addressPartsFromPlace(place) {
  const get = (type, short) => {
    const c = ((place && place.address_components) || []).find(x => (x.types || []).includes(type));
    return c ? (short ? c.short_name : c.long_name) : '';
  };
  const route = get('route').trim().split(/\s+/).filter(Boolean);
  const at = place && place.geometry && place.geometry.location;
  return {
    unit: get('subpremise'), street_number: get('street_number'),
    street_name: (route.length > 1 ? route.slice(0, -1) : route).join(' ').toUpperCase(),
    street_type: route.length > 1 ? route[route.length - 1].toUpperCase() : '',
    suburb: get('locality').toUpperCase(), state: get('administrative_area_level_1', true), postcode: get('postal_code'),
    lat: at ? at.lat() : null, lng: at ? at.lng() : null,
    place_id: (place && place.place_id) || null,
    formatted: String((place && place.formatted_address) || '').replace(/,\s*Australia\s*$/i, ''),
  };
}

// Letters and digits only, single spaced: how two spellings of an address are compared ("12-14" as "12 14").
const addressPlain = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// A typed address looked up. Returns the parts; false when Google was asked and has no such address
// (or its answer is another street number or postcode); null when it could not be asked (no key,
// offline, too slow, refused), so "could not ask" is never taken for "does not exist".
async function addressLookUp(text) {
  const typed = ` ${addressPlain(text)} `;
  if (typed.trim().length < 6) return false;
  const places = await addressMaps();
  if (!places) return null;
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), 8000);
    try {
      new places.AutocompleteService().getPlacePredictions({ input: text, componentRestrictions: { country: 'au' }, types: ['address'] }, (list, status) => {
        if (status === 'ZERO_RESULTS') { resolve(false); return; }
        const first = status === 'OK' && (list || [])[0];
        if (!first) { resolve(null); return; }
        new places.PlacesService(document.createElement('div')).getDetails({ placeId: first.place_id, fields: ['formatted_address', 'address_components', 'geometry', 'place_id'] }, (place, st) => {
          if (st !== 'OK' || !place) { resolve(null); return; }
          const parts = addressPartsFromPlace(place);
          const same = parts.street_number && parts.postcode
            && typed.includes(` ${addressPlain(parts.street_number)} `) && typed.includes(` ${parts.postcode} `);
          resolve(same ? parts : false);
        });
      });
    } catch (err) { resolve(null); }
  });
}

// Puts Google's suggestions on an address input. `parts`: the parts already saved for the text in
// the box (so an untouched box keeps them). onPick(parts) runs when a suggestion is chosen.
async function wireAddressBox(input, { parts = null, onPick = null } = {}) {
  if (!input || input.dataset.addressBox) return;
  input.dataset.addressBox = '1';
  input.addressParts = parts || null;
  input.addressFor = parts ? input.value.trim() : null;   // the text the parts belong to
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => { input.addressParts = null; input.addressFor = null; });
  input.addEventListener('blur', () => { addressBoxParts(input); });
  const places = await addressMaps();
  if (!places) return;
  const ac = new places.Autocomplete(input, { componentRestrictions: { country: 'au' }, fields: ['formatted_address', 'address_components', 'geometry', 'place_id'], types: ['address'] });
  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    if (!place || !place.address_components) return;
    const found = addressPartsFromPlace(place);
    input.value = found.formatted || input.value;
    input.addressParts = found;
    input.addressFor = input.value.trim();
    if (onPick) onPick(found);
  });
}

// The parts for what is in the box now (looked up if it was typed and not picked), or null.
// A box changed by other code (a site picker, a prefill) is noticed: the parts follow the text.
async function addressBoxParts(input) {
  const text = String((input && input.value) || '').trim();
  if (!text) return null;
  if (input.addressParts && input.addressFor === text) return input.addressParts;
  const found = (await addressLookUp(text)) || null;
  if (String(input.value || '').trim() !== text) return null;   // changed while looking
  input.addressParts = found;
  input.addressFor = found ? text : null;
  return found;
}

// The database columns for an address box, to spread into a save: the parts and the map point. An
// address with no parts clears both, so a changed address never keeps the old house's map point.
async function addressBoxColumns(input) {
  const parts = await addressBoxParts(input);
  return parts ? { address_parts: parts, lat: parts.lat, lng: parts.lng } : { address_parts: null, lat: null, lng: null };
}

// A job saved before addresses were kept in parts: looked up once and saved, so Formbay, Pylon and
// the map point read Google's answer and not a split of the text. An address Google does not know
// is marked so it is not asked about on every open. Returns the parts, or null.
async function addressKeepJob(project) {
  if (!project || project.address_parts || !String(project.client_address || '').trim()) return (project && project.address_parts) || null;
  const found = await addressLookUp(project.client_address);
  if (found === null) return null;   // could not ask Google just now: try again next time
  const fields = found ? { address_parts: found, lat: found.lat, lng: found.lng } : { address_parts: { unknown: true, formatted: String(project.client_address).trim() } };
  // only while the job still has that address and no parts (another tab or person may have changed it)
  const { error } = await supabaseClient.from('projects').update(fields).eq('id', project.id).is('address_parts', null).eq('client_address', project.client_address);
  if (!error) Object.assign(project, fields);
  return found || null;
}
