// POST /.netlify/functions/portal-read   (the device's portal token is the check, see
// _shared/portal-session.js). Everything the client portal reads (backlog item 74), body { action, projectId }:
//   overview  the lists: needs you, jobs, quotes, who the login is
//   job       one job or quote: status, bookings, who is on site, shared photos and documents,
//             invoices and variations (money only for an email on the client record), and on a
//             do and charge job the work so far (labour, materials, purchase orders)
// The queries and the whitelists are in _shared/portal-data.js. Reads only (the session's
// last-seen time aside).

const S = require('./_shared/portal-session');
const D = require('./_shared/portal-data');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return S.json(400, { ok: false, error: 'Bad request' }); }
  const auth = await S.requirePortalSession(event);
  if (!auth) return S.json(401, { ok: false, error: 'Please log in again.' });
  const { admin, scope } = auth;
  try {
    const action = String(body.action || 'overview');
    if (action === 'overview') return S.json(200, { ok: true, email: scope.email, ...(await D.portalOverview(admin, scope)) });
    const projectId = String(body.projectId || '');
    if (!UUID.test(projectId)) return S.json(400, { ok: false, error: 'Which job?' });
    if (action === 'job') {
      const job = await D.portalProject(admin, scope, projectId);
      return job ? S.json(200, { ok: true, email: scope.email, job }) : S.json(404, { ok: false, error: 'That job is not on your account.' });
    }
    return S.json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('portal-read failed:', err);
    return S.json(500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};
