// An address in parts as a browser sent it (public/js/address-box.js, item 103), made safe to save.
// Used wherever a server function saves an address for someone else: the portal's Request work,
// the referral page, Edit details on an invoice. Takes plain input, returns plain values.
//   addressColumns(input, address) -> { address_parts, lat, lng } to spread into an insert or update,
//     or {} when nothing usable came (the line of text is then all that is saved)
// The parts are kept only when they belong to the address text being saved: the street number and
// the postcode must both be in it, so parts for one house are never stored against another.

const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const coord = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

function addressColumns(input, address) {
  if (!input || typeof input !== 'object') return {};
  const parts = {
    unit: text(input.unit, 20), street_number: text(input.street_number, 20), street_name: text(input.street_name, 80).toUpperCase(),
    street_type: text(input.street_type, 30).toUpperCase(), suburb: text(input.suburb, 60).toUpperCase(), state: text(input.state, 3).toUpperCase(),
    postcode: text(input.postcode, 4), lat: coord(input.lat, -45, -9), lng: coord(input.lng, 110, 156),
    place_id: text(input.place_id, 200) || null, formatted: text(input.formatted, 300),
  };
  // compared as letters and digits only, so "12-14" matches "12 - 14"
  const plain = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const line = ` ${plain(address)} `;
  const number = plain(parts.street_number);
  if (!number || !/^\d{4}$/.test(parts.postcode) || number === parts.postcode) return {};
  if (!line.includes(` ${number} `) || !line.includes(` ${parts.postcode} `)) return {};
  return { address_parts: parts, lat: parts.lat, lng: parts.lng };
}

module.exports = { addressColumns };
