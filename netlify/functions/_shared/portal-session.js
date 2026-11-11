// The client portal's one door (backlog item 74). Every portal function calls requirePortalSession
// first: it reads the device's token from the Authorization header, finds the session by the
// token's hash, checks it is live, works out what that email may see (its scope) and keeps the
// session's last-seen time. Clients are never Supabase auth users, so none of the app's table
// policies apply here; the scope is the whole access control and every query in
// portal-data.js carries it.
//
//   requirePortalSession(event) -> { admin, session, scope, mustChange, log } or null (not logged in)
//     mustChange: the password is still the temporary one (or a code got them in): portal-read
//     refuses every read until set_password, so the page cannot skip choosing a password.
//     log(action, { projectId, detail }) writes the usage row (portal_events) for every client in
//     the scope, and a throttled line on the job's activity log for a job view or an open.
//   portalScope(admin, email, { staffCheck })
//       -> { email, clients: [{ id, name, main }], contactJobIds, staffUser, canLogIn, firstName }
//     staffCheck (one Auth listUsers call) only at login; a session's scope skips it.
//     clients: every client record the email is on (the client's own email, or a ticked contact);
//       main is true on the client's own email (it may let others in, PR 2). A client with
//       portal_off_at set is left out of the scope (so a shut-out client sees nothing).
//     contactJobIds: jobs where the email is a job contact (a builder's supervisor): that job only,
//       and never money (invoices, hours, costs, rates). A job of a client with the portal off is
//       left out here too, whoever the contact is.
//     staffUser: true when the email belongs to a staff login (refused: staff use the app).
//     canLogIn: the one test every door uses (on a client record, or a job contact).
//     firstName: the person's first name from the contact row, for an email; '' when unknown.
//   tokenHash(token), newToken(), codeHash(email, code), newCode()
//   hashPassword(password), verifyPassword(password, hash), newPassword(): scrypt with a random salt
//   noPasswordHash(): a stored hash nothing matches (an account that only ever used a code)
//   logPortalEvent(admin, { email, clientIds, projectId, action, detail })
//   json(statusCode, body)      the response shape every portal function answers with
//   normEmail(s)                lower case, trimmed
//
// Tables written: portal_sessions.last_seen_at, portal_events, activity_log (job views). Everything
// else here only reads.

const crypto = require('crypto');
const { getAdminClient } = require('./require-admin');
const { allAuthUsers } = require('./auth-users');
const { firstName } = require('./schedule-emails');

const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const PASSWORD_MIN = 8;
const ACTIVITY_THROTTLE_MINUTES = 60; // one "client viewed this job" line an hour, not one a click
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

// Passwords: scrypt (built into Node) with a 16 byte random salt, stored as scrypt$salt$hash.
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(password), salt, 64).toString('base64')}`;
};
const verifyPassword = (password, stored) => {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), want.length);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
// a stored hash nothing can match (random bytes where the scrypt result would be): verifyPassword
// still does its scrypt against it, so an unknown email takes as long as a wrong password
const noPasswordHash = () => `scrypt$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(64).toString('base64')}`;
// a temporary password a person can read out: three short words and two digits
const WORDS = ['solar', 'volt', 'cable', 'switch', 'bright', 'north', 'river', 'valley', 'spark', 'panel', 'power', 'amp', 'copper', 'tweed', 'summit', 'harbour'];
const newPassword = () => `${WORDS[crypto.randomInt(WORDS.length)]}-${WORDS[crypto.randomInt(WORDS.length)]}-${crypto.randomInt(10, 99)}`;

const ACTIVITY_ACTIONS = { viewed_job: 'viewed this job', opened_quote: 'opened the quote', opened_invoice: 'opened an invoice', opened_document: 'opened a document', opened_rates: 'opened the Schedule of Rates', opened_variation: 'opened a variation' };

async function logPortalEvent(admin, { email, clientIds = [], projectId = null, action, detail = null }) {
  // the job's activity log hears about a view or an open at most once an hour per person: the
  // usage rows (indexed by job) say whether this person did anything on the job in the last hour
  let tellJob = false;
  if (projectId && ACTIVITY_ACTIONS[action]) {
    const sinceIso = new Date(Date.now() - ACTIVITY_THROTTLE_MINUTES * 60 * 1000).toISOString();
    const { data: recent } = await admin.from('portal_events').select('id').eq('email', email).eq('project_id', projectId).in('action', Object.keys(ACTIVITY_ACTIONS)).gte('created_at', sinceIso).limit(1);
    tellJob = !(recent || []).length;
  }
  const rows = (clientIds.length ? clientIds : [null]).map((client_id) => ({ email, client_id, project_id: projectId, action, detail }));
  await admin.from('portal_events').insert(rows);
  if (tellJob) {
    await admin.from('activity_log').insert({ entity_type: 'project', entity_id: projectId, action: 'portal_view', description: `${email} ${ACTIVITY_ACTIONS[action]} in the client portal${detail ? ` (${detail})` : ''}` });
  }
}

async function portalScope(admin, emailIn, { staffCheck = true } = {}) {
  const email = normEmail(emailIn);
  if (!email) return { email, clients: [], contactJobIds: [], staffUser: false, canLogIn: false, firstName: '' };
  const like = likeSafe(email);
  const [{ data: own }, { data: ticked }, { data: jobContacts }, staffUser] = await Promise.all([
    admin.from('clients').select('id, name, portal_off_at').ilike('email', like),
    admin.from('client_contacts').select('name, clients(id, name, portal_off_at)').ilike('email', like).eq('portal_access', true),
    admin.from('job_contacts').select('name, project_id, projects(clients(portal_off_at))').ilike('email', like),
    staffCheck ? isStaffEmail(admin, email) : Promise.resolve(false),
  ]);
  // a client with the portal off is not in the scope at all
  const byId = {};
  (own || []).filter((c) => !c.portal_off_at).forEach((c) => { byId[c.id] = { id: c.id, name: c.name, main: true }; });
  (ticked || []).forEach((row) => {
    const c = row.clients;
    if (c && !c.portal_off_at && !byId[c.id]) byId[c.id] = { id: c.id, name: c.name, main: false };
  });
  const clients = Object.values(byId);
  const contactJobIds = [...new Set((jobContacts || []).filter((j) => j.project_id && !j.projects?.clients?.portal_off_at).map((j) => j.project_id))];
  const person = [...(ticked || []), ...(jobContacts || [])].map((r) => String(r.name || '').trim()).find(Boolean) || '';
  return { email, clients, contactJobIds, staffUser, canLogIn: clients.length > 0 || contactJobIds.length > 0, firstName: person ? firstName(person) : '' };
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
  const [scope, { data: account }] = await Promise.all([
    portalScope(admin, session.email, { staffCheck: false }),
    admin.from('portal_accounts').select('must_change').eq('email', session.email).maybeSingle(),
  ]);
  if (!scope.canLogIn) return null;
  const seenAgo = Date.now() - new Date(session.last_seen_at).getTime();
  if (seenAgo > SEEN_REFRESH_MINUTES * 60 * 1000) {
    await admin.from('portal_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', session.id);
  }
  const clientIds = scope.clients.map((c) => c.id);
  const log = (action, { projectId = null, detail = null } = {}) => logPortalEvent(admin, { email: scope.email, clientIds, projectId, action, detail }).catch((e) => console.error('portal event not logged', e.message));
  return { admin, session, scope, mustChange: !account || !!account.must_change, log };
}

module.exports = { requirePortalSession, portalScope, logPortalEvent, bearer, tokenHash, newToken, codeHash, newCode, hashPassword, verifyPassword, noPasswordHash, newPassword, json, normEmail, SESSION_DAYS, CODE_MINUTES, PASSWORD_MIN };
