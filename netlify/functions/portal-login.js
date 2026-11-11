// POST /.netlify/functions/portal-login   (public: the password or the email code is the check)
// The client portal's login (backlog item 74). Body { action, email, password, code, device }:
//   password    email and password. Right: the device's token (30 days, portal_sessions holds its
//               hash) and mustChange when the password is the temporary one. 5 wrong tries in an
//               hour locks the password until a code login; the answer never says whether the
//               email exists.
//   send        emails a 6 digit code to an email that is on a client record (the client's own
//               email, a ticked contact, or a job contact): the forgot-password path and the way in
//               before a welcome email. The answer is the same whether or not the email is known. A
//               staff email is told to use the app. Limits: one live code per email, 3 codes per
//               email per hour, 20 per IP per hour.
//   verify      checks the code (CODE_MINUTES, 5 wrong tries then it is dead), logs the device in
//               and asks for a new password (mustChange).
//   set_password a logged-in device sets the password (PASSWORD_MIN characters).
//   logout      ends this device's session; logout_all ends every session for the email.
// Writes portal_logins, portal_sessions, portal_accounts, portal_events, clients.portal_last_login_at
// and activity_log.

const { getAdminClient } = require('./_shared/require-admin');
const S = require('./_shared/portal-session');
const { sendPortalCode } = require('./_shared/portal-mail');

const MAX_ATTEMPTS = 5;
const PER_EMAIL_HOUR = 3;
const PER_IP_HOUR = 20;
const SAME_ANSWER = 'If that email is on a client record, a code is on its way.';
const TOO_MANY_TRIES = 'Too many wrong tries. Ask for a new code.';
const WRONG_PASSWORD = 'That email and password do not match. Try again, or choose "Email me a code instead".';

// an unknown email is checked against this, so the answer takes as long either way
const NO_ACCOUNT_HASH = S.noPasswordHash();
const ipOf = (event) => String((event.headers || {})['x-nf-client-connection-ip'] || (event.headers || {})['x-forwarded-for'] || '').split(',')[0].trim() || null;
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return S.json(400, { ok: false, error: 'Bad request' }); }
  const action = String(body.action || '');
  const email = S.normEmail(body.email);
  const device = String(body.device || '').slice(0, 200);
  const admin = getAdminClient();
  try {
    if (action === 'password') return await password(admin, event, email, String(body.password || ''), device);
    if (action === 'send') return await send(admin, event, email);
    if (action === 'verify') return await verify(admin, email, String(body.code || ''), device);
    if (action === 'set_password') return await setPassword(event, String(body.password || ''));
    if (action === 'logout' || action === 'logout_all') return await logout(event, admin, action === 'logout_all');
    return S.json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('portal-login failed:', err);
    return S.json(500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};

// A wrong password counts like a wrong code: a portal_logins row with no code, so the lockout
// and the per-IP limit read the same table.
async function password(admin, event, email, pw, device) {
  if (!email || !pw) return S.json(400, { ok: false, error: 'Type your email and password.' });
  const ip = ipOf(event);
  const [{ count: wrong }, { data: account }] = await Promise.all([
    admin.from('portal_logins').select('id', { count: 'exact', head: true }).eq('email', email).is('code_hash', null).eq('attempts', 1).gte('created_at', hourAgo()),
    admin.from('portal_accounts').select('id, password_hash, must_change').eq('email', email).maybeSingle(),
  ]);
  if ((wrong || 0) >= MAX_ATTEMPTS) return S.json(429, { ok: false, error: 'Too many wrong tries. Choose "Email me a code instead" to get back in.' });
  const ok = S.verifyPassword(pw, account ? account.password_hash : NO_ACCOUNT_HASH) && !!account;
  if (!ok) {
    await admin.from('portal_logins').insert({ email, code_hash: null, ip, attempts: 1, expires_at: new Date().toISOString(), used_at: new Date().toISOString() });
    return S.json(400, { ok: false, error: WRONG_PASSWORD });
  }
  const scope = await S.portalScope(admin, email, { staffCheck: false });
  if (!scope.canLogIn) return S.json(403, { ok: false, error: 'This email is not on a client record any more. Call us if that is wrong.' });
  return S.json(200, { ok: true, ...(await openSession(admin, scope, device, 'login_password')), mustChange: !!account.must_change });
}

async function send(admin, event, email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.json(400, { ok: false, error: 'Please type your email address.' });
  const ip = ipOf(event);
  const [{ count: byEmail }, { count: byIp }] = await Promise.all([
    admin.from('portal_logins').select('id', { count: 'exact', head: true }).eq('email', email).not('code_hash', 'is', null).gte('created_at', hourAgo()),
    ip ? admin.from('portal_logins').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', hourAgo()) : Promise.resolve({ count: 0 }),
  ]);
  if ((byEmail || 0) >= PER_EMAIL_HOUR || (byIp || 0) >= PER_IP_HOUR) {
    return S.json(429, { ok: false, error: 'Too many codes asked for. Please wait an hour, or call us.' });
  }
  const scope = await S.portalScope(admin, email);
  if (scope.staffUser) return S.json(200, { ok: true, staff: true, message: 'That is a staff login. Use the app instead.' });
  if (!scope.canLogIn) {
    // unknown email: the same words, no code (code_hash null), but the attempt still counts against the limits
    await admin.from('portal_logins').insert({ email, code_hash: null, ip, expires_at: new Date().toISOString(), used_at: new Date().toISOString() });
    return S.json(200, { ok: true, message: SAME_ANSWER, minutes: S.CODE_MINUTES });
  }
  const code = S.newCode();
  // one live code per email: the earlier ones die
  await admin.from('portal_logins').update({ used_at: new Date().toISOString() }).eq('email', email).is('used_at', null);
  const { error } = await admin.from('portal_logins').insert({ email, code_hash: S.codeHash(email, code), ip, expires_at: new Date(Date.now() + S.CODE_MINUTES * 60 * 1000).toISOString() });
  if (error) throw error;
  try {
    await sendPortalCode(admin, { to: email, code });
  } catch (e) {
    console.error('portal-login: the code email did not send', e.message);
    return S.json(502, { ok: false, error: 'We could not send the email just now. Please try again in a minute, or call us.' });
  }
  return S.json(200, { ok: true, message: SAME_ANSWER, minutes: S.CODE_MINUTES });
}

async function verify(admin, email, codeIn, device) {
  const code = codeIn.replace(/\D/g, '');
  if (!email || code.length !== 6) return S.json(400, { ok: false, error: 'Type the 6 digit code from the email.' });
  const { data: login } = await admin.from('portal_logins').select('*').eq('email', email).is('used_at', null).not('code_hash', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!login || new Date(login.expires_at).getTime() < Date.now()) return S.json(400, { ok: false, error: 'That code has run out. Ask for a new one.' });
  if (login.attempts >= MAX_ATTEMPTS) return S.json(400, { ok: false, error: TOO_MANY_TRIES });
  if (login.code_hash !== S.codeHash(email, code)) {
    const attempts = login.attempts + 1;
    await admin.from('portal_logins').update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) }).eq('id', login.id);
    return S.json(400, { ok: false, error: attempts >= MAX_ATTEMPTS ? TOO_MANY_TRIES : 'That code is not right. Check the email and try again.' });
  }
  // send already refused a staff email, so no Auth lookup here
  const scope = await S.portalScope(admin, email, { staffCheck: false });
  if (!scope.canLogIn) return S.json(403, { ok: false, error: 'This email is not on a client record any more. Call us if that is wrong.' });
  await admin.from('portal_logins').update({ used_at: new Date().toISOString() }).eq('id', login.id);
  // a code login always ends in choosing a password (the account is made if it is their first time)
  const { error: accountErr } = await admin.from('portal_accounts').upsert({ email, password_hash: S.noPasswordHash(), must_change: true, updated_at: new Date().toISOString() }, { onConflict: 'email' });
  if (accountErr) throw accountErr;
  return S.json(200, { ok: true, ...(await openSession(admin, scope, device, 'login_code')), mustChange: true });
}

async function openSession(admin, scope, device, how) {
  const token = S.newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + S.SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from('portal_sessions').insert({ token_hash: S.tokenHash(token), email: scope.email, device: device || null, expires_at: expiresAt });
  if (error) throw error;
  const clientIds = scope.clients.map((c) => c.id);
  await Promise.all([
    admin.from('portal_accounts').update({ last_login_at: now.toISOString() }).eq('email', scope.email),
    clientIds.length ? admin.from('clients').update({ portal_last_login_at: now.toISOString() }).in('id', clientIds) : null,
    clientIds.length ? admin.from('activity_log').insert(clientIds.map((id) => ({ entity_type: 'client', entity_id: id, action: 'portal_login', description: `${scope.email} logged in to the client portal` }))) : null,
    S.logPortalEvent(admin, { email: scope.email, clientIds, action: how, detail: device ? device.slice(0, 80) : null }),
  ]);
  return { token, expiresAt };
}

async function setPassword(event, pw) {
  const auth = await S.requirePortalSession(event);
  if (!auth) return S.json(401, { ok: false, error: 'Please log in again.' });
  if (pw.length < S.PASSWORD_MIN) return S.json(400, { ok: false, error: `Use at least ${S.PASSWORD_MIN} characters.` });
  // the part before the @, when it is long enough to mean anything (jo@ would refuse Majorca)
  const local = auth.scope.email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return S.json(400, { ok: false, error: 'Pick a password that is not part of your email.' });
  const { error } = await auth.admin.from('portal_accounts').upsert({ email: auth.scope.email, password_hash: S.hashPassword(pw), must_change: false, updated_at: new Date().toISOString() }, { onConflict: 'email' });
  if (error) throw error;
  auth.log('set_password');
  return S.json(200, { ok: true });
}

// By the token alone (no scope check), so a client who was shut out can still end their sessions.
async function logout(event, admin, everywhere) {
  const token = S.bearer(event);
  if (!token) return S.json(200, { ok: true });
  const { data: session } = await admin.from('portal_sessions').select('id, email').eq('token_hash', S.tokenHash(token)).maybeSingle();
  if (!session) return S.json(200, { ok: true });
  const ended = new Date().toISOString();
  if (everywhere) await admin.from('portal_sessions').update({ ended_at: ended }).eq('email', session.email).is('ended_at', null);
  else await admin.from('portal_sessions').update({ ended_at: ended }).eq('id', session.id);
  await S.logPortalEvent(admin, { email: session.email, action: everywhere ? 'logout_all' : 'logout' }).catch(() => {});
  return S.json(200, { ok: true });
}
