// Where a Pylon design's site is (backlog item 75): Pylon's API has no production or roof pitch
// figures for a design, but its solar project carries the site's own location
// (site_location: [longitude, latitude]). Used by site-sun.js to look up the site's sun records.
// Reading only. Returns { lat, lng } or null: any failure here is null, never an error, because
// the caller has another way to find the place (the address).
//
// NOTE: written from Pylon's API reference (https://observer.getpylon.com/docs/api), not checked
// against a live answer. How a design names its project is not shown there, so the design is
// asked for in the ways the reference allows and the first answer that names a solar project is
// used. What comes back is logged (ids only) so this can be tightened once seen.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

const API = 'https://api.getpylon.com/v1';
const inAustralia = (lat, lng) => lat > -45 && lat < -9 && lng > 110 && lng < 155;

async function pylonSiteLocation(designId) {
  try {
    if (!designId) return null;
    const apiKey = await getIntegrationKey('pylon');
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' };
    const get = async (path) => { const res = await fetch(`${API}${path}`, { headers }); return res.ok ? res.json() : null; };
    let projectId = null;
    for (const fields of ['', '?fields[solar_designs]=summary,solar_project', '?fields[solar_designs]=summary,project']) {
      const design = await get(`/solar_designs/${encodeURIComponent(designId)}${fields}`);
      const rel = Object.values(((design || {}).data || {}).relationships || {}).map(r => r && r.data).find(d => d && d.type === 'solar_projects' && d.id);
      if (rel) { projectId = rel.id; break; }
    }
    if (!projectId) { console.log('pylon-location: the design names no solar project', designId); return null; }
    const project = await get(`/solar_projects/${encodeURIComponent(projectId)}?fields[solar_projects]=site_location`);
    const loc = (((project || {}).data || {}).attributes || {}).site_location;
    if (!Array.isArray(loc) || loc.length < 2) { console.log('pylon-location: the project has no site_location', projectId); return null; }
    const lng = Number(loc[0]), lat = Number(loc[1]);
    return inAustralia(lat, lng) ? { lat, lng } : null;
  } catch (err) {
    console.error('pylon-location failed:', err.message);
    return null;
  }
}

module.exports = { pylonSiteLocation, inAustralia };
