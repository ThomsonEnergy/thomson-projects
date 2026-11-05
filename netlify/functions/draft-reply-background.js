// Background: Draft reply pressed in the Inbox (item 55). Postie drafts one conversation the
// same way it drafts Priority mail, in the mailbox's voice, and saves it as an open draft in
// email_drafts and Gmail Drafts; the Inbox waits for that row and fills the reply box.
//
// Started only by email-actions.js (action draft_reply), which checks the person may use the
// mailbox and that no draft is open; this function checks the internal secret and checks the
// person's access again. A background function, as an Opus draft can take longer than the 10
// second limit. Nothing is ever sent.

const { requireInternal } = require('./_shared/require-internal');
const { getAdminClient } = require('./_shared/require-admin');
const { threadForUser } = require('./_shared/mailboxes');
const { draftOnRequest } = require('./_shared/email-agent');

exports.handler = async (event) => {
  if (!requireInternal(event)) {
    console.error('draft-reply-background: refused, no internal secret');
    return { statusCode: 202, body: '' };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 202, body: '' }; }
  try {
    const admin = getAdminClient();
    const t = await threadForUser(admin, body.thread_id, body.user_id);
    if (!t || !t.owner) { console.error('draft-reply-background: no access to', body.thread_id); return { statusCode: 202, body: '' }; }
    const { count } = await admin.from('email_drafts').select('id', { count: 'exact', head: true }).eq('thread_id', t.thread.id).eq('status', 'draft');
    if (count) return { statusCode: 202, body: '' }; // someone saved a draft meanwhile
    const r = await draftOnRequest(admin, t.mailbox, t.thread);
    if (!r.drafted) console.error('draft-reply-background: nothing drafted for', t.thread.id);
  } catch (err) {
    console.error('draft-reply-background failed:', err.message);
  }
  return { statusCode: 202, body: '' };
};
