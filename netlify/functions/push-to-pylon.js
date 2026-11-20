const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');

// POST /.netlify/functions/push-to-pylon
// Body: { name, email, phone, address, referenceNumber, lat, lng }
//
// "Create job in Pylon" used to just open a blank Pylon tab, meaning
// staff retyped the client's name/phone/email/site address a second
// time. This creates the Pylon project via their documented
// POST /v1/solar_projects (https://app.getpylon.com/docs/api) with that
// info already filled in, so staff land on a project that already has
// the customer/site details and just need to do the actual system
// design. Deliberately doesn't touch pricing - Jasper wants pricing
// worked out in this app, not duplicated into Pylon.
//
// Pylon wants a structured site_address (line1/city/state/zip/country).
// The job's address in parts (projects.address_parts, from Google's
// lookup, item 103) is used when the page sends it. A job with no parts
// falls back to splitting the standard AU Google format ("123 Smith St,
// Suburb STATE 1234, Australia") with a regex; a hand-typed address
// that doesn't match this shape fails with a clear message rather than
// silently sending a broken request.
//
// The "owner" relationship is optional in Pylon's docs (defaults to
// whichever user the API key belongs to), so this doesn't ask for or
// store any Pylon user mapping.

const { addressColumns } = require('./_shared/address-parts');
const AU_STATES = 'ACT|NSW|NT|QLD|SA|TAS|VIC|WA';
const ADDRESS_RE = new RegExp(`^(.+?),\\s*([A-Za-z .'-]+?)\\s+(${AU_STATES})\\s+(\\d{4})\\s*(?:,\\s*Australia)?$`, 'i');

// The parts Google gave, in Pylon's shape (null when the job has none).
function fromParts(p) {
  if (!p || !p.suburb || !p.state) return null;
  const street = [p.unit ? `${p.unit}/${p.street_number}` : p.street_number, p.street_name, p.street_type].filter(Boolean).join(' ');
  const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { line1: title(street), city: title(p.suburb), state: p.state, zip: p.postcode, country: 'Australia' };
}

function splitAddress(address) {
  const m = (address || '').trim().match(ADDRESS_RE);
  if (!m) return null;
  const [, line1, city, state, zip] = m;
  return { line1: line1.trim(), city: city.trim(), state: state.toUpperCase(), zip, country: 'Australia' };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { name, email, phone, address, addressParts, referenceNumber, lat, lng } = JSON.parse(event.body || '{}');
    if (!name || !address) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Client name and site address are required first.' }) };
    }

    const site_address = fromParts(addressColumns(addressParts, address).address_parts) || splitAddress(address);
    if (!site_address) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: `Could not split "${address}" into street/suburb/state/postcode. Re-pick the address from the autocomplete suggestions, or enter it as "123 Smith St, Suburb STATE 1234".` }) };
    }

    const apiKey = await getIntegrationKey('pylon');

    const attributes = { site_address };
    if (referenceNumber) attributes.reference_number = referenceNumber;
    if (typeof lat === 'number' && typeof lng === 'number') attributes.site_location = [lng, lat];
    const customer_details = {};
    if (name) customer_details.name = name;
    if (phone) customer_details.phone = phone;
    if (email) customer_details.email = email;
    if (Object.keys(customer_details).length) attributes.customer_details = customer_details;

    const res = await fetch('https://api.getpylon.com/v1/solar_projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({ data: { type: 'solar_projects', attributes } }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Pylon project creation failed:', res.status, JSON.stringify(json));
      const detail = json?.errors?.[0]?.detail || JSON.stringify(json);
      throw new Error(`Pylon rejected the request: ${res.status} ${detail}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        pylonProjectId: json.data?.id || null,
        referenceNumber: json.data?.attributes?.reference_number || referenceNumber || null,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
