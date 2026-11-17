// POST /.netlify/functions/portal-invite   (any active staff login)
// Sends a client their portal login (backlog item 74; the work is _shared/portal-invite.js): makes the portal account with a temporary
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
const { sendPortalInvite } = require('./_shared/portal-invite');

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
    const result = await sendPortalInvite(admin, email, { resend: !!body.resend, actorId: auth.user.id });
    return S.json(200, { ok: true, ...result });
  } catch (err) {
    if (err.statusCode === 400) return S.json(400, { ok: false, error: err.message });
    console.error('portal-invite failed:', err);
    return S.json(500, { ok: false, error: /not connected/.test(err.message) ? 'sales@ is not connected, so the email could not go.' : 'Something went wrong. Please try again.' });
  }
};
