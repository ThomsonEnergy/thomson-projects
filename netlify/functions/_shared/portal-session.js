// The client portal's one door (backlog item 74). Every portal function calls requirePortalSession
// first: it reads the device's token from the Authorization header, finds the session by the
// token's hash, checks it is live, works out what that email may see (its scope) and keeps the
// session's last-seen time. Clients are never Supabase auth users, so none of the app's table
// policies apply here; the scope is the whole access control and every query in
// portal-data.js carries it.
//
//   requirePortalSession(event) -> { admin, session, scope } or null (not logged in)
//   portalScope(admin, email, { staffCheck })
//                               -> { email, clients: [{ id, name, main, offAt }], contactJobIds, staffUser }
//     staffCheck (one Auth listUsers call) only at login; a session's scope skips it.
//     clients: every client record the email is on (the client's own email, or a ticked contact);
//       main is true on the client's own email (it may let others in, PR 2). A client with
//       portal_off_at set is left out of the scope (so a shut-out client sees nothing).
//     contactJobIds: jobs where the email is a job contact (a builder's supervisor): that job only,
//       and never money (invoices, hours, costs, rates).
//     staffUser: true when the email belongs to a staff login (refused: staff use the app).
//   tokenHash(token), newToken(), codeHash(email, code), newCode()
//   json(statusCode, body)      the response shape every portal function answers with
//   normEmail(s)                lower case, trimmed
//
// Tables written: portal_sessions.last_seen_at. Everything else here only reads.

const crypto = require('crypto');
const { getAdminClient } = require('./require-admin');
const { allAuthUsers } = require('./auth-users');

const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const SEEN_REFRESH_MINUTES = 10;

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const normEmail = (s) => String(s || '').trim().toLowerCase();
// ilike treats % and _ as wildcards: an email is matched letter for letter
const likeSafe = (s) => String(s).replace(/[\\%_]/g, '\\$&');
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
// the code's hash is salted with the email, so two people sent the same digits never share a hash
const codeHash = (email, code) => crypto.createHash('sha256').update(`${normEmail(email)}:${String(code).replace(/\D/g, '')}`).digest('hex');

async function portalScope(admin, emailIn, { staffCheck = true } = {}) {
  const email = normEmail(emailIn);
  if (!email) return { email, clients: [], contactJobIds: [], staffUser: false };
  const like = likeSafe(email);
  const [{ data: own }, { data: ticked }, { data: jobContacts }, staffUser] = await Promise.all([
    admin.from('clients').select('id, name, portal_off_at').ilike('email', like),
    admin.from('client_contacts').select('client_id, clients(id, name, portal_off_at)').ilike('email', like).eq('portal_access', true),
    admin.from('job_contacts').select('project_id').ilike('email', like),
    staffCheck ? isStaffEmail(admin, email) : Promise.resolve(false),
  ]);
  const byId = {};
  (own || []).forEach((c) => { byId[c.id] = { id: c.id, name: c.name, main: true, offAt: c.portal_off_at }; });
  (ticked || []).forEach((row) => {
    const c = row.clients;
    if (!c) return;
    if (!byId[c.id]) byId[c.id] = { id: c.id, name: c.name, main: false, offAt: c.portal_off_at };
  });
  const clients = Object.values(byId).filter((c) => !c.offAt);
  const contactJobIds = [...new Set((jobContacts || []).map((j) => j.project_id).filter(Boolean))];
  return { email, clients, contactJobIds, staffUser };
}

// Email lives only in Supabase Auth, so this is the Auth user list (paged, _shared/auth-users.js).
async function isStaffEmail(admin, email) {
  try {
    return (await allAuthUsers(admin)).some((u) => normEmail(u.email) === email);
  } catch (e) {
    console.error('portal-session: could not check staff emails', e.message);
    return false;
  }
}

function bearer(event) {
  const h = (event.headers || {}).authorization || (event.headers || {}).Authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function requirePortalSession(event) {
  const token = bearer(event);
  if (!token || token.length < 20) return null;
  const admin = getAdminClient();
  const { data: session } = await admin.from('portal_sessions').select('*').eq('token_hash', tokenHash(token)).maybeSingle();
  if (!session || session.ended_at || new Date(session.expires_at).getTime() < Date.now()) return null;
  const scope = await portalScope(admin, session.email, { staffCheck: false });
  if (!scope.clients.length && !scope.contactJobIds.length) return null;
  const seenAgo = Date.now() - new Date(session.last_seen_at).getTime();
  if (seenAgo > SEEN_REFRESH_MINUTES * 60 * 1000) {
    await admin.from('portal_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', session.id);
  }
  return { admin, session, scope };
}

module.exports = { requirePortalSession, portalScope, bearer, tokenHash, newToken, codeHash, newCode, json, normEmail, SESSION_DAYS, CODE_MINUTES };
