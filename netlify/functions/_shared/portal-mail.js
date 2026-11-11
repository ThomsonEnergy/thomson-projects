// The portal's login code email (backlog item 74): a plain send from sales@ through Gmail, the
// same connection every client email uses, but not recorded on a job or in the Inbox (a code is
// noise there). Nothing else is sent from here.
//
//   sendPortalCode(admin, { to, code }) -> { ok } or throws
// Reads mailboxes and company_settings; writes nothing.

const { gmailRequest, GMAIL_MAILBOX } = require('./google-client');
const { sharedMailbox } = require('./mailboxes');
const { buildMimeMessage } = require('./build-mime-message');
const { plainTextToHtml } = require('./build-email-signature');
const { CODE_MINUTES } = require('./portal-session');

async function sendPortalCode(admin, { to, code }) {
  const [mailbox, { data: company }] = await Promise.all([
    sharedMailbox(admin),
    admin.from('company_settings').select('company_name, phone').eq('id', 1).maybeSingle(),
  ]);
  if (!mailbox) throw new Error('sales@ is not connected.');
  const name = company?.company_name || 'Thomson Energy';
  const bodyText = [
    `Your ${name} login code is:`,
    '',
    code,
    '',
    `It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
    '',
    name + (company?.phone ? `, ${company.phone}` : ''),
  ].join('\n');
  const mail = { fromName: name, fromAddress: GMAIL_MAILBOX, to, subject: `${code} is your ${name} login code`, bodyText, bodyHtml: plainTextToHtml(bodyText) };
  await gmailRequest('messages/send', { method: 'POST', body: { raw: buildMimeMessage(mail) } }, mailbox);
  return { ok: true };
}

module.exports = { sendPortalCode };
