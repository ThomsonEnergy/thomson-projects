// POST (any signed-in staff member). Undoes or clears up after the email workers
// (email-workers.js), for the bits that also need Gmail:
//   { action: 'not_spam', thread_id }      Bouncer got it wrong: back in the Inbox here and in Gmail
//   { action: 'discard_draft', draft_id }  Ghostwriter's draft is not wanted: gone here and from Gmail Drafts
// Undoing a tag and confirming a suggestion need no Gmail, so the Inbox page does those itself.

const { requireActiveUser } = require('./_shared/require-active-user');
const { gmailRequest, gmailDeleteDraft } = require('./_shared/google-client');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in' });
  const { supabaseAdmin } = auth;
  try {
    const { action, thread_id: threadId, draft_id: draftId } = JSON.parse(event.body || '{}');

    if (action === 'not_spam') {
      const { data: thread } = await supabaseAdmin.from('email_threads').select('id, gmail_thread_id').eq('id', threadId).maybeSingle();
      if (!thread) return json(404, { ok: false, error: 'Conversation not found' });
      await supabaseAdmin.from('email_threads').update({ spam_at: null }).eq('id', thread.id);
      await supabaseAdmin.from('emails').update({ ai_category: 'other' }).eq('thread_id', thread.id).eq('ai_category', 'spam');
      try {
        await gmailRequest(`threads/${thread.gmail_thread_id}/modify`, { method: 'POST', body: { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] } });
      } catch (err) {
        return json(200, { ok: true, warning: `Back in the TEops Inbox, but Gmail said: ${err.message}` });
      }
      return json(200, { ok: true });
    }

    if (action === 'discard_draft') {
      const { data: draft } = await supabaseAdmin.from('email_drafts').select('id, gmail_draft_id, status').eq('id', draftId).maybeSingle();
      if (!draft) return json(404, { ok: false, error: 'Draft not found' });
      if (draft.status === 'ready') {
        await gmailDeleteDraft(draft.gmail_draft_id);
        await supabaseAdmin.from('email_drafts').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', draft.id);
      }
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('email-worker-action failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
