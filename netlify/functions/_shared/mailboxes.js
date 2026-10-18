// Mailboxes: sales@ (shared) and each person's own Gmail (personal, private to them).
// Who may use what, and keeping Gmail in step with TEops (labels, archive, read,
// drafts). See migration 20261021000000 and docs/PROJECT_SPEC.md A18.
//
// Gmail mirroring needs the gmail.modify permission. sales@ was first connected
// read and send only: until it is connected again from Settings, mirroring is
// skipped quietly and TEops keeps working on its own copy.

const { gmailRequest } = require('./google-client');
const { buildMimeMessage } = require('./build-mime-message');

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_LABEL_PREFIX = 'TEops/';
const FORBIDDEN_PERSONAL = ['sales@thomsonenergy.com.au', 'invoice@thomsonenergy.com.au'];

async function sharedMailbox(admin) {
  const { data } = await admin.from('mailboxes').select('*').eq('kind', 'shared').order('created_at').limit(1).maybeSingle();
  return data;
}

async function connectedPersonalMailboxes(admin) {
  const { data } = await admin.from('mailboxes').select('*').eq('kind', 'personal').not('connected_at', 'is', null);
  return data || [];
}

async function mailboxById(admin, id) {
  if (!id) return null;
  const { data } = await admin.from('mailboxes').select('*').eq('id', id).maybeSingle();
  return data;
}

// The person may work in this mailbox: sales@ for every active staff member, a personal one only for its owner.
function canUseMailbox(mailbox, userId) {
  return !!mailbox && (mailbox.kind === 'shared' || mailbox.owner_id === userId);
}

// A thread plus its mailbox, if the person may see it (their mailbox, sales@, or tagged to a job).
async function threadForUser(admin, threadId, userId) {
  const { data: thread } = await admin.from('email_threads').select('*').eq('id', threadId).maybeSingle();
  if (!thread) return null;
  const mailbox = await mailboxById(admin, thread.mailbox_id);
  if (canUseMailbox(mailbox, userId)) return { thread, mailbox, owner: true };
  const { count } = await admin.from('email_job_links').select('id', { count: 'exact', head: true }).eq('thread_id', threadId);
  return count ? { thread, mailbox, owner: false } : null;
}

const canMirror = (mailbox) => !!mailbox && String(mailbox.scopes || '').includes(MODIFY_SCOPE);

// Gmail errors while mirroring never stop the TEops change.
async function quietly(what, fn) {
  try { return await fn(); } catch (err) { console.error(`Gmail ${what} failed:`, err.message); return null; }
}

async function modifyThread(mailbox, gmailThreadId, { add = [], remove = [] }) {
  if (!canMirror(mailbox) || !gmailThreadId) return null;
  return quietly('thread update', () => gmailRequest(`threads/${gmailThreadId}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } }, mailbox));
}

const archiveInGmail = (mailbox, thread, done) => modifyThread(mailbox, thread.gmail_thread_id, done ? { remove: ['INBOX'] } : { add: ['INBOX'] });
const markReadInGmail = (mailbox, thread) => modifyThread(mailbox, thread.gmail_thread_id, { remove: ['UNREAD'] });

// The Gmail label for a TEops label ("TEops/Supplier dispute"), made the first time it is needed.
async function ensureGmailLabel(admin, mailbox, label) {
  if (!canMirror(mailbox)) return null;
  if (label.gmail_label_id) return label.gmail_label_id;
  return quietly('label create', async () => {
    const name = GMAIL_LABEL_PREFIX + label.name;
    let gl;
    try {
      gl = await gmailRequest('labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }, mailbox);
    } catch (err) {
      if (err.status !== 409) throw err; // already exists in Gmail: find it
      const list = await gmailRequest('labels', {}, mailbox);
      gl = (list.labels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (!gl) throw err;
    }
    await admin.from('email_labels').update({ gmail_label_id: gl.id }).eq('id', label.id);
    return gl.id;
  });
}

async function labelInGmail(admin, mailbox, thread, label, on) {
  const gid = await ensureGmailLabel(admin, mailbox, label);
  if (!gid) return null;
  return modifyThread(mailbox, thread.gmail_thread_id, on ? { add: [gid] } : { remove: [gid] });
}

async function renameGmailLabel(mailbox, label, newName) {
  if (!canMirror(mailbox) || !label.gmail_label_id) return null;
  return quietly('label rename', () => gmailRequest(`labels/${label.gmail_label_id}`, { method: 'PATCH', body: { name: GMAIL_LABEL_PREFIX + newName } }, mailbox));
}

async function deleteGmailLabel(mailbox, label) {
  if (!canMirror(mailbox) || !label.gmail_label_id) return null;
  return quietly('label delete', () => gmailRequest(`labels/${label.gmail_label_id}`, { method: 'DELETE' }, mailbox));
}

// Keeps a Gmail draft in step with a TEops draft, so it also shows in the Gmail app.
// Returns the Gmail draft id (or the old one if Gmail could not be reached).
async function saveGmailDraft(admin, mailbox, draft, { fromName, inReplyTo, gmailThreadId }) {
  if (!canMirror(mailbox)) return draft.gmail_draft_id || null;
  const raw = buildMimeMessage({
    fromName: fromName || 'Thomson Energy',
    fromAddress: mailbox.address,
    to: draft.to_addresses || '',
    cc: draft.cc_addresses || undefined,
    subject: draft.subject || '',
    bodyText: draft.body_text || '',
    bodyHtml: undefined,
    inReplyTo: inReplyTo || undefined,
    references: inReplyTo || undefined,
  });
  const message = gmailThreadId ? { raw, threadId: gmailThreadId } : { raw };
  const saved = await quietly('draft save', async () => {
    if (draft.gmail_draft_id) {
      try {
        return await gmailRequest(`drafts/${draft.gmail_draft_id}`, { method: 'PUT', body: { id: draft.gmail_draft_id, message } }, mailbox);
      } catch (err) {
        if (err.status !== 404) throw err; // deleted in Gmail: make a new one
      }
    }
    return gmailRequest('drafts', { method: 'POST', body: { message } }, mailbox);
  });
  if (saved?.id && saved.id !== draft.gmail_draft_id && draft.id) {
    await admin.from('email_drafts').update({ gmail_draft_id: saved.id }).eq('id', draft.id);
  }
  return saved?.id || draft.gmail_draft_id || null;
}

async function deleteGmailDraft(mailbox, draft) {
  if (!canMirror(mailbox) || !draft.gmail_draft_id) return null;
  return quietly('draft delete', () => gmailRequest(`drafts/${draft.gmail_draft_id}`, { method: 'DELETE' }, mailbox));
}

module.exports = {
  MODIFY_SCOPE, FORBIDDEN_PERSONAL, sharedMailbox, connectedPersonalMailboxes, mailboxById, canUseMailbox, threadForUser,
  canMirror, archiveInGmail, markReadInGmail, ensureGmailLabel, labelInGmail, renameGmailLabel, deleteGmailLabel,
  saveGmailDraft, deleteGmailDraft,
};
