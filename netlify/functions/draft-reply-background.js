// Background: Draft reply pressed in the Inbox (item 55). Postie drafts one conversation the
// same way it drafts Priority mail, in the mailbox's voice, and saves it as an open draft in
// email_drafts and Gmail Drafts; the Inbox waits for that row and fills the reply box.
//
// Started only by email-actions.js (action draft_reply), which checks the person may use the
// mailbox, that no draft is open and that the AI key is set; this function checks the internal
// secret and the person's access again. A background function, as an Opus draft can take longer
// than the 10 second limit. Reports to the ops manager as "draft-reply" (runs, AI use, a
// failure alert). Nothing is ever sent.

const { requireInternal } = require('./_shared/require-internal');
const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');
const { threadForUser } = require('./_shared/mailboxes');
const { draftOnRequest } = require('./_shared/email-agent');

exports.handler = (event) => {
  if (!requireInternal(event)) {
    console.error('draft-reply-background: refused, no internal secret');
    return { statusCode: 202, body: '' };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 202, body: '' }; }
  return runAgent('draft-reply', async () => {
    const admin = getAdminClient();
    const t = await threadForUser(admin, body.thread_id, body.user_id);
    if (!t || !t.owner) return { summary: 'Draft reply refused: no access to that conversation' };
    const r = await draftOnRequest(admin, t.mailbox, t.thread);
    return { summary: `${t.mailbox.address}: ${r.drafted ? 'reply drafted on request' : 'no draft (a reply or draft came in first)'}`, usage: r.usage };
  });
};
