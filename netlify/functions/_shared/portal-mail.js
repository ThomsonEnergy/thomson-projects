// The portal's own emails (backlog item 74): the login code and the welcome with a temporary
// password. Plain sends from sales@ through Gmail, the same connection every client email uses,
// but not recorded on a job or in the Inbox (they are noise there). Nothing else is sent from here.
//
//   sendPortalCode(admin, { to, code }) -> { ok } or throws
//   sendPortalWelcome(admin, { to, password, name }) -> { ok } or throws
//   portalLine(admin, email) -> the 'see it in your portal' line for a client email, or ''
// Reads mailboxes and company_settings; writes nothing.

const { gmailRequest, GMAIL_MAILBOX } = require('./google-client');
const { sharedMailbox } = require('./mailboxes');
const { buildMimeMessage } = require('./build-mime-message');
const { plainTextToHtml } = require('./build-email-signature');
const { CODE_MINUTES } = require('./portal-session');
const { publicBaseUrl } = require('./site-url');

async function companyAndMailbox(admin) {
  const [mailbox, { data: company }] = await Promise.all([
    sharedMailbox(admin),
    admin.from('company_settings').select('company_name, phone').eq('id', 1).maybeSingle(),
  ]);
  if (!mailbox) throw new Error('sales@ is not connected.');
  return { mailbox, name: company?.company_name || 'Thomson Energy', phone: company?.phone || '' };
}

async function sendPlain(mailbox, mail) {
  await gmailRequest('messages/send', { method: 'POST', body: { raw: buildMimeMessage({ ...mail, bodyHtml: plainTextToHtml(mail.bodyText) }) } }, mailbox);
  return { ok: true };
}

async function sendPortalCode(admin, { to, code }) {
  const { mailbox, name, phone } = await companyAndMailbox(admin);
  const bodyText = [
    `Your ${name} login code is:`,
    '',
    code,
    '',
    `It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
    '',
    name + (phone ? `, ${phone}` : ''),
  ].join('\n');
  return sendPlain(mailbox, { fromName: name, fromAddress: GMAIL_MAILBOX, to, subject: `${code} is your ${name} login code`, bodyText });
}

async function sendPortalWelcome(admin, { to, password, name: toName }) {
  const { mailbox, name, phone } = await companyAndMailbox(admin);
  const url = `${publicBaseUrl()}/portal.html`;
  const bodyText = [
    `Hi${toName ? ` ${toName}` : ''},`,
    '',
    `You can now see your quotes, jobs, bookings, photos and invoices with ${name} online.`,
    '',
    `Log in: ${url}`,
    `Email: ${to}`,
    `Temporary password: ${password}`,
    '',
    'It will ask you to choose your own password the first time. If you ever forget it, choose "Email me a code instead" on the login page.',
    '',
    name + (phone ? `, ${phone}` : ''),
  ].join('\n');
  return sendPlain(mailbox, { fromName: name, fromAddress: GMAIL_MAILBOX, to, subject: `Your ${name} login`, bodyText });
}

// The line client emails end with when the person can log in to the portal (item 74 PR 2): booking,
// plan and message emails from the app. '' for anyone who cannot (no account is made by it). Never a
// token in the link: the portal asks them to log in.
async function portalLine(admin, email) {
  const S = require('./portal-session');
  try {
    const scope = await S.portalScope(admin, S.normEmail(email), { staffCheck: false });
    if (!scope.canLogIn || scope.staffUser) return '';
  } catch (e) { return ''; }
  return `\n\nSee your jobs, bookings, photos and invoices any time in your portal: ${publicBaseUrl()}/portal.html`;
}

module.exports = { sendPortalCode, sendPortalWelcome, portalLine };
