// POST /.netlify/functions/portal-invite   (any active staff login)
// Sends a client their portal login (backlog item 74): makes the portal account with a temporary
// password if there is none, emails "Your login" from sales@ (_shared/portal-mail.js) and stamps
// welcome_sent_at. The Clients page calls it by itself for every contact newly ticked Portal and
// for "Send login" on the card; the job's Contacts card has "Send portal login" on a contact with
// an email. Body { email, resend }: an email that already had its welcome is only sent again
// with resend true, and a client who has chosen their own password is never sent a new temporary
// one (that would wipe their password; the login page's "Email me a code instead" is their way
// back in). The email must be one that can log in (on a client record or a job contact).
// Writes portal_accounts and activity_log.

const { requireActiveUser } = require('./_shared/require-active-user');
const S = require('./_shared/portal-session');
const { sendPortalWelcome } = require('./_shared/portal-mail');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return S.json(403, { ok: false, error: 'Not authorized' });
  const admin = auth.supabaseAdmin;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return S.json(400, { ok: false, error: 'Bad request' }); }
  const email = S.normEmail(body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.json(400, { ok: false, error: 'That is not an email address.' });
  try {
    const scope = await S.portalScope(admin, email);
    if (scope.staffUser) return S.json(400, { ok: false, error: 'That is a staff login, not a client.' });
    if (!scope.canLogIn) return S.json(400, { ok: false, error: 'That email is not on a client record or a job yet. Save it first.' });
    const { data: existing } = await admin.from('portal_accounts').select('id, welcome_sent_at, must_change').eq('email', email).maybeSingle();
    if (existing && existing.welcome_sent_at && !body.resend) return S.json(200, { ok: true, sent: false, message: 'Already sent.' });
    if (existing && !existing.must_change) return S.json(200, { ok: true, sent: false, message: 'They already have their own password. If they have forgotten it, "Email me a code instead" on the login page gets them back in.' });
    // The new temporary password only ever replaces a temporary one (checked above), so it goes in
    // first; welcome_sent_at is stamped only once the email has gone, so a send that fails is tried
    // again by itself on the next save or tick.
    const password = S.newPassword();
    const now = new Date().toISOString();
    const { error } = await admin.from('portal_accounts').upsert({ email, password_hash: S.hashPassword(password), must_change: true, updated_at: now }, { onConflict: 'email' });
    if (error) throw error;
    await sendPortalWelcome(admin, { to: email, password, name: scope.firstName });
    await admin.from('portal_accounts').update({ welcome_sent_at: now }).eq('email', email);
    const clientIds = scope.clients.map((c) => c.id);
    if (clientIds.length) await admin.from('activity_log').insert(clientIds.map((id) => ({ entity_type: 'client', entity_id: id, action: 'portal_invite', description: `Portal login emailed to ${email}`, changed_by: auth.user.id })));
    return S.json(200, { ok: true, sent: true });
  } catch (err) {
    console.error('portal-invite failed:', err);
    return S.json(500, { ok: false, error: /not connected/.test(err.message) ? 'sales@ is not connected, so the email could not go.' : 'Something went wrong. Please try again.' });
  }
};
