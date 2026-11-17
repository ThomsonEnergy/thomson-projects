// Sends one email address its client portal login (backlog item 74). The one copy used by
// portal-invite.js (staff: the Clients page tick, Send login, a job contact's Send portal login)
// and portal-write.js (a client's main email adding someone on the portal's People card).
//
//   sendPortalInvite(admin, email, { resend, actorId, actorLabel })
//     -> { sent: true } or { sent: false, message } or throws a Refused error (statusCode 400)
// Makes the portal account with a temporary password if there is none and emails "Your login"
// from sales@ (_shared/portal-mail.js). An email that already had its welcome is only sent again
// with resend; a client who chose their own password is never sent a new temporary one (that would
// wipe it; "Email me a code instead" is their way back in). The email must be one that can log in.
// Writes portal_accounts and activity_log.

const S = require('./portal-session');
const { sendPortalWelcome } = require('./portal-mail');

class Refused extends Error { constructor(msg) { super(msg); this.statusCode = 400; } }

async function sendPortalInvite(admin, rawEmail, { resend = false, actorId = null, actorLabel = null } = {}) {
  const email = S.normEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refused('That is not an email address.');
  const scope = await S.portalScope(admin, email);
  if (scope.staffUser) throw new Refused('That is a staff login, not a client.');
  if (!scope.canLogIn) throw new Refused('That email is not on a client record or a job yet. Save it first.');
  const { data: existing } = await admin.from('portal_accounts').select('id, welcome_sent_at, must_change').eq('email', email).maybeSingle();
  if (existing && existing.welcome_sent_at && !resend) return { sent: false, message: 'Already sent.' };
  if (existing && !existing.must_change) return { sent: false, message: 'They already have their own password. If they have forgotten it, "Email me a code instead" on the login page gets them back in.' };
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
  if (clientIds.length) {
    await admin.from('activity_log').insert(clientIds.map((id) => ({ entity_type: 'client', entity_id: id, action: 'portal_invite', description: `Portal login emailed to ${email}${actorLabel ? ` (${actorLabel})` : ''}`, changed_by: actorId })));
  }
  return { sent: true };
}

module.exports = { sendPortalInvite, Refused };
