// POST /.netlify/functions/email-actions   { action, ... }   (any active staff member)
// Everything on the Inbox page that also has to change Gmail, or that staff cannot write
// directly. Each action checks the person may use that mailbox: sales@ for everyone, a
// personal mailbox only for its owner.
//
//   set_section      { thread_id, section, always }   move to Priority / Other / Updates (always: rule for the sender)
//   done             { thread_id, done }               archive (or back to the inbox), also in Gmail
//   mark_read        { thread_id }                     read in Gmail too (personal mailboxes)
//   add_label        { thread_id, label_id }  remove_label { thread_id, label_id }
//   create_label     { mailbox_id, name, description, thread_id? }
//   update_label     { label_id, name?, description?, status? }   delete_label { label_id }
//   accept_label / dismiss_label   { thread_id }        the agent's suggested new label
//   accept_job / dismiss_job       { thread_id }        the agent's suggested job
//   save_draft       { draft_id?, mailbox_id, thread_id?, to, cc, subject, body }
//   discard_draft    { draft_id }
//   cleanup_scan     { mailbox_id }                    start (or start again) the clean up scan
//   cleanup_queue    { mailbox_id, senders: [], queue: archive | read | unsubscribe | keep }
//   cleanup_read_older { mailbox_id, days }
//   disconnect       { mailbox_id }                    My inbox only

const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { startMailboxWork } = require('./_shared/gmail-sync');
const {
  mailboxById, canUseMailbox, threadForUser, archiveInGmail, markReadInGmail, labelInGmail,
  renameGmailLabel, deleteGmailLabel, saveGmailDraft, deleteGmailDraft,
} = require('./_shared/mailboxes');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const SECTIONS = ['priority', 'other', 'updates'];
const addrOf = (raw) => { const m = String(raw || '').match(/<([^>]+)>/); return (m ? m[1] : String(raw || '')).trim().toLowerCase(); };
const clean = (s, n) => String(s == null ? '' : s).replace(/—/g, ',').trim().slice(0, n);

class Refused extends Error {}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  const admin = auth.supabaseAdmin;
  const userId = auth.user.id;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request.' }); }

  // a conversation in a mailbox this person works in
  const ownThread = async (threadId) => {
    const t = threadId ? await threadForUser(admin, threadId, userId) : null;
    if (!t || !t.owner) throw new Refused('Conversation not found.');
    return t;
  };
  const ownMailbox = async (mailboxId) => {
    const mb = await mailboxById(admin, mailboxId);
    if (!canUseMailbox(mb, userId)) throw new Refused('Mailbox not found.');
    return mb;
  };
  const ownLabel = async (labelId) => {
    const { data: label } = await admin.from('email_labels').select('*').eq('id', labelId).maybeSingle();
    if (!label) throw new Refused('Label not found.');
    return { label, mailbox: await ownMailbox(label.mailbox_id) };
  };
  const ownDraft = async (draftId) => {
    const { data: draft } = await admin.from('email_drafts').select('*').eq('id', draftId).maybeSingle();
    if (!draft) throw new Refused('Draft not found.');
    return { draft, mailbox: await ownMailbox(draft.mailbox_id) };
  };
  const fromName = async () => (await admin.from('profiles').select('full_name').eq('id', userId).single()).data?.full_name || 'Thomson Energy';

  async function makeLabel(mailbox, name, description) {
    const n = clean(name, 60);
    if (!n) throw new Refused('Give the label a name.');
    const { data: existing } = await admin.from('email_labels').select('*').eq('mailbox_id', mailbox.id).ilike('name', n.replace(/[%_]/g, '\\$&')).maybeSingle();
    if (existing) return existing;
    const { data: label, error } = await admin.from('email_labels')
      .insert({ mailbox_id: mailbox.id, name: n, description: clean(description, 300) || null, created_by: userId }).select('*').single();
    if (error) throw error;
    return label;
  }
  async function applyLabel(t, label, on) {
    if (label.mailbox_id !== t.mailbox.id) throw new Refused('That label belongs to the other inbox.');
    if (on) {
      const { error } = await admin.from('email_thread_labels').upsert({ thread_id: t.thread.id, label_id: label.id, added_by: userId }, { onConflict: 'thread_id,label_id', ignoreDuplicates: true });
      if (error) throw error;
    } else {
      await admin.from('email_thread_labels').delete().eq('thread_id', t.thread.id).eq('label_id', label.id);
    }
    await labelInGmail(admin, t.mailbox, t.thread, label, on);
  }

  try {
    switch (body.action) {
      case 'set_section': {
        const t = await ownThread(body.thread_id);
        if (!SECTIONS.includes(body.section)) throw new Refused('Unknown section.');
        await admin.from('email_threads').update({ section: body.section, section_by: 'person', section_reason: null, triaged_at: new Date().toISOString() }).eq('id', t.thread.id);
        if (body.always) {
          const { data: last } = await admin.from('emails').select('from_address').eq('thread_id', t.thread.id).eq('direction', 'inbound').order('sent_at', { ascending: false }).limit(1).maybeSingle();
          const sender = addrOf(last?.from_address);
          if (sender) {
            await admin.from('email_sender_rules').delete().eq('mailbox_id', t.mailbox.id).ilike('sender', sender);
            await admin.from('email_sender_rules').insert({ mailbox_id: t.mailbox.id, sender, section: body.section, created_by: userId });
            // the rest of this sender's unsorted or agent-sorted mail follows the rule
            const { data: theirs } = await admin.from('emails').select('thread_id').ilike('from_address', `%${sender}%`).limit(1000);
            const ids = [...new Set((theirs || []).map((e) => e.thread_id))];
            for (let i = 0; i < ids.length; i += 200) {
              await admin.from('email_threads').update({ section: body.section, section_by: 'rule', section_reason: 'Your rule for this sender' })
                .eq('mailbox_id', t.mailbox.id).in('id', ids.slice(i, i + 200)).or('section_by.is.null,section_by.neq.person');
            }
          }
        }
        return json(200, { ok: true });
      }
      case 'done': {
        const t = await ownThread(body.thread_id);
        await admin.from('email_threads').update({ is_done: !!body.done, is_read: true }).eq('id', t.thread.id);
        await archiveInGmail(t.mailbox, t.thread, !!body.done);
        return json(200, { ok: true });
      }
      case 'mark_read': {
        const t = await ownThread(body.thread_id);
        await admin.from('email_threads').update({ is_read: true }).eq('id', t.thread.id);
        if (t.mailbox.kind === 'personal') await markReadInGmail(t.mailbox, t.thread);
        return json(200, { ok: true });
      }
      case 'add_label':
      case 'remove_label': {
        const t = await ownThread(body.thread_id);
        const { label } = await ownLabel(body.label_id);
        await applyLabel(t, label, body.action === 'add_label');
        return json(200, { ok: true });
      }
      case 'create_label': {
        const mb = await ownMailbox(body.mailbox_id);
        const label = await makeLabel(mb, body.name, body.description);
        if (body.thread_id) await applyLabel(await ownThread(body.thread_id), label, true);
        return json(200, { ok: true, label });
      }
      case 'update_label': {
        const { label, mailbox } = await ownLabel(body.label_id);
        const patch = {};
        if (body.name !== undefined && clean(body.name, 60) && clean(body.name, 60) !== label.name) {
          patch.name = clean(body.name, 60);
          await renameGmailLabel(mailbox, label, patch.name);
        }
        if (body.description !== undefined) patch.description = clean(body.description, 300) || null;
        if (body.status !== undefined) patch.status = body.status === 'done' ? 'done' : 'open';
        if (Object.keys(patch).length) {
          const { error } = await admin.from('email_labels').update(patch).eq('id', label.id);
          if (error) throw new Refused(error.code === '23505' ? 'There is already a label with that name.' : error.message);
        }
        return json(200, { ok: true });
      }
      case 'delete_label': {
        const { label, mailbox } = await ownLabel(body.label_id);
        await deleteGmailLabel(mailbox, label);
        await admin.from('email_labels').delete().eq('id', label.id);
        return json(200, { ok: true });
      }
      case 'accept_label': {
        const t = await ownThread(body.thread_id);
        if (!t.thread.suggested_label) throw new Refused('No suggested label.');
        const label = await makeLabel(t.mailbox, t.thread.suggested_label, null);
        await applyLabel(t, label, true);
        await admin.from('email_threads').update({ suggested_label: null }).eq('id', t.thread.id);
        return json(200, { ok: true, label });
      }
      case 'dismiss_label': {
        const t = await ownThread(body.thread_id);
        await admin.from('email_threads').update({ suggested_label: null }).eq('id', t.thread.id);
        return json(200, { ok: true });
      }
      case 'accept_job': {
        const t = await ownThread(body.thread_id);
        if (!t.thread.suggested_project_id) throw new Refused('No suggested job.');
        await admin.from('email_job_links').upsert({ thread_id: t.thread.id, project_id: t.thread.suggested_project_id, kind: 'client', created_by: userId }, { onConflict: 'thread_id,project_id', ignoreDuplicates: true });
        await admin.from('email_threads').update({ suggested_project_id: null }).eq('id', t.thread.id);
        return json(200, { ok: true });
      }
      case 'dismiss_job': {
        const t = await ownThread(body.thread_id);
        await admin.from('email_threads').update({ suggested_project_id: null }).eq('id', t.thread.id);
        return json(200, { ok: true });
      }
      case 'save_draft': {
        let draft, mailbox;
        if (body.draft_id) ({ draft, mailbox } = await ownDraft(body.draft_id));
        else mailbox = await ownMailbox(body.mailbox_id);
        let t = null;
        const threadId = draft ? draft.thread_id : body.thread_id;
        if (threadId) {
          t = await ownThread(threadId);
          if (t.mailbox.id !== mailbox.id) throw new Refused('That conversation is in the other inbox.');
        }
        const fields = {
          to_addresses: clean(body.to, 1000), cc_addresses: clean(body.cc, 1000) || null, subject: clean(body.subject, 300),
          body_text: String(body.body || '').slice(0, 50000), updated_at: new Date().toISOString(),
        };
        if (draft) {
          await admin.from('email_drafts').update(fields).eq('id', draft.id);
          draft = { ...draft, ...fields };
        } else {
          const { data, error } = await admin.from('email_drafts').insert({ ...fields, mailbox_id: mailbox.id, thread_id: t ? t.thread.id : null, created_by: userId }).select('*').single();
          if (error) throw error;
          draft = data;
        }
        let inReplyTo = null;
        if (t) inReplyTo = (await admin.from('emails').select('message_id_header').eq('thread_id', t.thread.id).order('sent_at', { ascending: false }).limit(1).maybeSingle()).data?.message_id_header;
        await saveGmailDraft(admin, mailbox, draft, { fromName: await fromName(), inReplyTo, gmailThreadId: t ? t.thread.gmail_thread_id : null });
        return json(200, { ok: true, draft_id: draft.id });
      }
      case 'discard_draft': {
        const { draft, mailbox } = await ownDraft(body.draft_id);
        await admin.from('email_drafts').update({ status: 'discarded', updated_at: new Date().toISOString() }).eq('id', draft.id);
        await deleteGmailDraft(mailbox, draft);
        return json(200, { ok: true });
      }
      case 'cleanup_scan': {
        const mb = await ownMailbox(body.mailbox_id);
        await admin.from('mailbox_cleanup_senders').delete().eq('mailbox_id', mb.id);
        await admin.from('mailboxes').update({
          cleanup_started_at: new Date().toISOString(), cleanup_done_at: null, cleanup_page_token: null, cleanup_scanned: 0, cleanup_estimate: null,
        }).eq('id', mb.id);
        await startMailboxWork();
        return json(200, { ok: true });
      }
      case 'cleanup_queue': {
        const mb = await ownMailbox(body.mailbox_id);
        const senders = (Array.isArray(body.senders) ? body.senders : []).map((s) => String(s).toLowerCase()).slice(0, 1000);
        if (!senders.length) throw new Refused('Pick at least one sender.');
        for (let i = 0; i < senders.length; i += 200) {
          const chunk = senders.slice(i, i + 200);
          if (body.queue === 'keep') {
            await admin.from('mailbox_cleanup_senders').update({ done_action: 'keep', done_at: new Date().toISOString(), queued_action: null }).eq('mailbox_id', mb.id).in('sender', chunk);
          } else if (['archive', 'read', 'unsubscribe'].includes(body.queue)) {
            await admin.from('mailbox_cleanup_senders').update({ queued_action: body.queue }).eq('mailbox_id', mb.id).in('sender', chunk);
          } else {
            throw new Refused('Unknown clean up action.');
          }
        }
        if (body.queue !== 'keep') await startMailboxWork();
        return json(200, { ok: true });
      }
      case 'cleanup_read_older': {
        const mb = await ownMailbox(body.mailbox_id);
        const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 30));
        await admin.from('mailboxes').update({ cleanup_read_older_days: days }).eq('id', mb.id);
        await startMailboxWork();
        return json(200, { ok: true });
      }
      case 'disconnect': {
        const mb = await ownMailbox(body.mailbox_id);
        if (mb.kind !== 'personal') throw new Refused('sales@ is connected from Settings.');
        const { data: tok } = await admin.from('mailbox_tokens').select('refresh_token').eq('mailbox_id', mb.id).maybeSingle();
        if (tok?.refresh_token) {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok.refresh_token)}`, { method: 'POST' }).catch(() => null);
        }
        await admin.from('mailbox_tokens').delete().eq('mailbox_id', mb.id);
        await admin.from('mailboxes').update({
          connected_at: null, disconnected_at: new Date().toISOString(), history_id: null, backfill_page_token: null, backfill_done_at: null,
          cleanup_started_at: null, cleanup_done_at: null, cleanup_page_token: null, cleanup_read_older_days: null,
        }).eq('id', mb.id);
        // private mail goes; conversations tagged to a job stay on the job (business records)
        const { data: tagged } = await admin.from('email_job_links').select('thread_id, email_threads!inner(mailbox_id)').eq('email_threads.mailbox_id', mb.id);
        const keep = new Set((tagged || []).map((l) => l.thread_id));
        const { data: all } = await admin.from('email_threads').select('id').eq('mailbox_id', mb.id);
        const drop = (all || []).map((t) => t.id).filter((id) => !keep.has(id));
        for (let i = 0; i < drop.length; i += 200) await admin.from('email_threads').delete().in('id', drop.slice(i, i + 200));
        await admin.from('email_drafts').delete().eq('mailbox_id', mb.id);
        await admin.from('mailbox_cleanup_senders').delete().eq('mailbox_id', mb.id);
        return json(200, { ok: true, kept: keep.size, removed: drop.length });
      }
      default:
        return json(400, { ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    if (err instanceof Refused) return json(400, { ok: false, error: err.message });
    console.error('email-actions failed:', body.action, err.message);
    return json(500, { ok: false, error: err.message });
  }
};
