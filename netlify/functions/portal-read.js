// POST /.netlify/functions/portal-read   (the device's portal token is the check, see
// _shared/portal-session.js). Everything the client portal reads (backlog item 74), body { action, projectId }:
//   overview  the lists: needs you, jobs, quotes, who the login is
//   job       one job or quote: status, bookings, who is on site, shared photos and documents,
//             invoices and variations (money only for an email on the client record), and on a
//             do and charge job the work so far (labour, materials, purchase orders)
//   event     the page says a link was opened ({ kind: opened_quote | opened_invoice | opened_document
//             | opened_variation | opened_rates, projectId, detail }); nothing is read
// Every call writes its usage row (portal_events) through auth.log; the queries and the whitelists
// are in _shared/portal-data.js.

const S = require('./_shared/portal-session');
const D = require('./_shared/portal-data');
const { jobRef } = require('./_shared/schedule-emails');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_KINDS = ['opened_quote', 'opened_invoice', 'opened_document', 'opened_variation', 'opened_rates'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return S.json(400, { ok: false, error: 'Bad request' }); }
  const auth = await S.requirePortalSession(event);
  if (!auth) return S.json(401, { ok: false, error: 'Please log in again.' });
  if (auth.mustChange) return S.json(403, { ok: false, mustChange: true, error: 'Choose your password first.' });
  const { admin, scope, log } = auth;
  try {
    const action = String(body.action || 'overview');
    if (action === 'overview') {
      const [data] = await Promise.all([D.portalOverview(admin, scope), log('viewed_list')]);
      return S.json(200, { ok: true, email: scope.email, ...data });
    }
    const projectId = String(body.projectId || '');
    if (!UUID.test(projectId)) return S.json(400, { ok: false, error: 'Which job?' });
    if (action === 'job') {
      const p = await D.scopedProject(admin, scope, projectId);
      if (!p) return S.json(404, { ok: false, error: 'That job is not on your account.' });
      const [job] = await Promise.all([D.portalProject(admin, p), log('viewed_job', { projectId, detail: jobRef(p) })]);
      return S.json(200, { ok: true, email: scope.email, job });
    }
    if (action === 'event') {
      const kind = String(body.kind || '');
      if (!OPEN_KINDS.includes(kind)) return S.json(400, { ok: false, error: 'Unknown event' });
      if (!(await D.scopedProject(admin, scope, projectId))) return S.json(404, { ok: false, error: 'That job is not on your account.' });
      await log(kind, { projectId, detail: String(body.detail || '').slice(0, 80) || null });
      return S.json(200, { ok: true });
    }
    return S.json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('portal-read failed:', err);
    return S.json(500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};
