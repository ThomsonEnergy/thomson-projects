// Where a quote's Pylon site is (backlog item 75): Pylon's API has no production or roof pitch
// figures for a design, but its solar project carries the site's own location
// (site_location: [longitude, latitude]). Used by site-sun.js to look up the site's sun records.
// Reading only. Returns { lat, lng } or null: any failure here is null, never an error, because
// the caller has another way to find the place (the address). Pylon gets ten seconds in all.
//
// The id on a quote (projects.pylon_project_id) is a Pylon project's when "Create job in Pylon"
// made it (push-to-pylon.js) and a design's when it was typed in for the equipment sync
// (pylon-sync.js), so it is tried as a project first and then as a design that names its project.
// A Pylon site in another postcode than the quote's address is not used (a copied quote keeps its
// Pylon id but can be for another property).
//
// NOTE: written from Pylon's API reference (https://observer.getpylon.com/docs/api), not checked
// against a live answer. How a design names its project is not shown there, so the design is
// asked for in the ways the reference allows and the first answer that names a solar project is
// used. When none does, the relationship names that did come back are logged so this can be
// tightened once seen.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const API = 'https://api.getpylon.com/v1';
const inAustralia = (lat, lng) => lat > -45 && lat < -9 && lng > 110 && lng < 155;

async function pylonSiteLocation(pylonId, postcode) {
  try {
    if (!pylonId) return null;
    const apiKey = await getIntegrationKey('pylon');
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' };
    const until = Date.now() + 10000;
    const get = async (path) => {
      const left = until - Date.now();
      if (left < 500) return null;
      const res = await fetch(`${API}${path}`, { headers, timeout: left });
      return res.ok ? res.json() : null;
    };
    const siteOf = (projectId) => get(`/solar_projects/${encodeURIComponent(projectId)}?fields[solar_projects]=site_location,site_address`);

    let project = await siteOf(pylonId);
    if (!project) {
      let projectId = null, seen = '';
      for (const fields of ['', '?fields[solar_designs]=summary,solar_project', '?fields[solar_designs]=summary,project']) {
        const design = await get(`/solar_designs/${encodeURIComponent(pylonId)}${fields}`);
        const rels = ((design || {}).data || {}).relationships || {};
        const rel = Object.values(rels).map(r => r && r.data).find(d => d && d.type === 'solar_projects' && d.id);
        if (rel) { projectId = rel.id; break; }
        if (design) seen = Object.keys(rels).join(', ') || 'none';
      }
      if (!projectId) { console.log(`pylon-location: ${pylonId} is not a project, and as a design names no solar project (relationships seen: ${seen || 'no answer'})`); return null; }
      project = await siteOf(projectId);
    }
    const attrs = ((project || {}).data || {}).attributes || {};
    const loc = attrs.site_location;
    if (!Array.isArray(loc) || loc.length < 2) { console.log('pylon-location: the Pylon project has no site_location', pylonId); return null; }
    const zip = String((attrs.site_address || {}).zip || '').trim();
    if (postcode && zip && zip !== postcode) { console.log('pylon-location: the Pylon site is in another postcode than the quote, not used', pylonId); return null; }
    const lng = Number(loc[0]), lat = Number(loc[1]);
    return inAustralia(lat, lng) ? { lat, lng } : null;
  } catch (err) {
    console.error('pylon-location failed:', err.message);
    return null;
  }
}

module.exports = { pylonSiteLocation, inAustralia };
