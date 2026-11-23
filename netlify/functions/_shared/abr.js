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

// The name search answers with a status code, the details call with a word: both leave here as a word.
const STATUS_WORDS = { '0000000001': 'Active', '0000000002': 'Cancelled' };
const statusWord = (s) => STATUS_WORDS[s] || (/^\d+$/.test(String(s || '')) ? '' : String(s || ''));

// { ok, abn, name, businessNames, status, statusFrom, entityType, gstFrom, state, postcode } or { ok: false, message }
async function abnDetails(abn) {
  const guid = await getIntegrationKey('abr_guid');
  const clean = String(abn || '').replace(/\s+/g, '');
  const res = await fetch(`https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(clean)}&guid=${encodeURIComponent(guid)}`, { timeout: 10000 });
  const data = JSON.parse(stripJsonp(await res.text()));
  if (!data.Abn) return { ok: false, message: data.Message || 'ABN not found.' };
  return {
    ok: true, abn: data.Abn, name: data.EntityName, businessNames: data.BusinessName || [], status: statusWord(data.AbnStatus),
    statusFrom: data.AbnStatusEffectiveFrom || null, entityType: data.EntityTypeName || null,
    gstFrom: data.Gst || null, state: data.AddressState || null, postcode: data.AddressPostcode || null,
  };
}

// [{ name, abn, status ('Active' | 'Cancelled' | ''), active, nameType, state, postcode }], active ones first.
// details: for the first N different ABNs the register is asked who is behind the name, and each of those
// results also carries { entityName, entityType, gstRegistered, activeFrom }: two businesses can share a
// business name, and only the entity tells them apart. A details call that fails leaves its result plain.
async function searchNames(name, maxResults = 10, { details = 0 } = {}) {
  const guid = await getIntegrationKey('abr_guid');
  const res = await fetch(`https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(String(name).trim())}&maxResults=${maxResults}&guid=${encodeURIComponent(guid)}`, { timeout: 10000 });
  const data = JSON.parse(stripJsonp(await res.text()));
  const results = (data.Names || []).map(n => {
    const status = statusWord(n.AbnStatus);
    return { name: n.Name, abn: n.Abn, status, active: status === 'Active', nameType: n.NameType || null, state: n.State, postcode: n.Postcode };
  });
  results.sort((a, b) => (a.status === 'Cancelled') - (b.status === 'Cancelled'));
  const abns = [...new Set(results.map(r => r.abn).filter(Boolean))].slice(0, Math.max(0, Number(details) || 0));
  const found = await Promise.all(abns.map(abn => abnDetails(abn).catch(() => null)));
  const byAbn = new Map(found.filter(d => d && d.ok).map(d => [String(d.abn), d]));
  results.forEach((r) => {
    const d = byAbn.get(String(r.abn));
    if (d) Object.assign(r, { entityName: d.name, entityType: d.entityType, gstRegistered: !!d.gstFrom, activeFrom: d.statusFrom, status: d.status || r.status, active: /^active$/i.test(d.status || r.status) });
  });
  return { results, message: data.Message || null };
}

module.exports = { abnDetails, searchNames };
