// The ABN Lookup web service (abr.business.gov.au), used by abn-lookup.js (staff lookups in the
// browser) and the supplier bill reader (checking the supplier details on each bill). The GUID
// is an integration key (api_keys abr_guid). The service always answers JSONP, so the wrapper is
// stripped before parsing.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

function stripJsonp(text) {
  const match = text.match(/^\s*\w+\((.*)\)\s*$/s);
  return match ? match[1] : text;
}

// { ok, abn, name, businessNames, status, gstFrom, state, postcode } or { ok: false, message }
async function abnDetails(abn) {
  const guid = await getIntegrationKey('abr_guid');
  const clean = String(abn || '').replace(/\s+/g, '');
  const res = await fetch(`https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(clean)}&guid=${encodeURIComponent(guid)}`, { timeout: 10000 });
  const data = JSON.parse(stripJsonp(await res.text()));
  if (!data.Abn) return { ok: false, message: data.Message || 'ABN not found.' };
  return {
    ok: true, abn: data.Abn, name: data.EntityName, businessNames: data.BusinessName || [], status: data.AbnStatus,
    gstFrom: data.Gst || null, state: data.AddressState || null, postcode: data.AddressPostcode || null,
  };
}

// [{ name, abn, status, state, postcode }]
async function searchNames(name, maxResults = 10) {
  const guid = await getIntegrationKey('abr_guid');
  const res = await fetch(`https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(String(name).trim())}&maxResults=${maxResults}&guid=${encodeURIComponent(guid)}`, { timeout: 10000 });
  const data = JSON.parse(stripJsonp(await res.text()));
  return { results: (data.Names || []).map(n => ({ name: n.Name, abn: n.Abn, status: n.AbnStatus, state: n.State, postcode: n.Postcode })), message: data.Message || null };
}

module.exports = { abnDetails, searchNames };
