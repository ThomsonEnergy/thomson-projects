// POST /.netlify/functions/send-gmail
// Body: { to, cc, subject, bodyText, replyToThreadId?, attachments?, tagProjectId?, tagKind? }
//   attachments: [{ bucket: 'email-attachments' | 'project-documents', path, name }]
//                (files are uploaded to storage by the browser first - never sent through
//                 here - and attached from there; up to 10 files, 20 MB in total)
//   tagProjectId: also tag the conversation to that job (kind: materials_quote | client | supplier | other)
// Any active staff member. Sends as sales@thomsonenergy.com.au, with the
// sending user's own name in the From display name and their saved
// signature appended to the body - so the client sees a real person's
// name even though the address is always sales@, matching what Jasper
// asked for. Sends via the Gmail API (not SMTP) specifically so the sent
// message shows up correctly threaded in the real Gmail Sent folder too,
// not just in this app.

const { requireActiveUser } = require('./_shared/require-active-user');
const { gmailRequest, gmailUploadSend, GMAIL_MAILBOX } = require('./_shared/google-client');
const { buildMimeMessage, buildRfc822 } = require('./_shared/build-mime-message');
const { signatureForUser, plainTextToHtml } = require('./_shared/build-email-signature');

const ALLOWED_BUCKETS = ['email-attachments', 'project-documents'];
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip', dwg: 'application/acad', mp4: 'video/mp4' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['materials_quote', 'client', 'supplier', 'other'];

async function loadAttachments(supabaseAdmin, list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} files.`);
  const out = []; let total = 0;
  for (const a of list) {
    if (!a || !ALLOWED_BUCKETS.includes(a.bucket) || typeof a.path !== 'string' || !a.path || a.path.includes('..')) throw new Error('One of the attachments is not valid.');
    const { data, error } = await supabaseAdmin.storage.from(a.bucket).download(a.path);
    if (error || !data) throw new Error(`Could not read the attachment "${a.name || a.path}": ${error ? error.message : 'not found'}`);
    const content = Buffer.from(await data.arrayBuffer());
    total += content.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('The attachments add up to more than 20 MB. Send them in more than one email.');
    const name = String(a.name || a.path.split('/').pop() || 'file').replace(/[\r\n\\/]/g, '_').slice(0, 150);
    const ext = (name.split('.').pop() || '').toLowerCase();
    out.push({ filename: name, mime: MIME_BY_EXT[ext] || data.type || 'application/octet-stream', content, storage: { bucket: a.bucket, path: a.path } });
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { to, cc, subject, bodyText, replyToThreadId, attachments: attachmentRefs, tagProjectId, tagKind } = JSON.parse(event.body || '{}');
    if (!to || !subject || !bodyText) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'to, subject and bodyText are required' }) };
    }

    const { supabaseAdmin, user } = auth;
    const { data: profile } = await supabaseAdmin.from('profiles').select('full_name').eq('id', user.id).single();
    const signature = await signatureForUser(supabaseAdmin, user);
    const fullBody = `${bodyText}\n\n${signature.text}`;
    const fullHtml = `${plainTextToHtml(bodyText)}${signature.html}`;
    const attachments = await loadAttachments(supabaseAdmin, attachmentRefs);

    let thread = null;
    let lastMessage = null;
    if (replyToThreadId) {
      const { data: t } = await supabaseAdmin.from('email_threads').select('*').eq('id', replyToThreadId).maybeSingle();
      thread = t;
      if (thread) {
        const { data: last } = await supabaseAdmin
          .from('emails').select('*').eq('thread_id', thread.id).order('sent_at', { ascending: false }).limit(1).maybeSingle();
        lastMessage = last;
      }
    }

    const finalSubject = thread && !/^re:/i.test(subject) ? `Re: ${subject}` : subject;
    const mail = {
      fromName: profile?.full_name || 'Thomson Energy Sales',
      fromAddress: GMAIL_MAILBOX,
      to,
      cc,
      subject: finalSubject,
      bodyText: fullBody,
      bodyHtml: fullHtml,
      inReplyTo: lastMessage?.message_id_header || undefined,
      references: lastMessage?.message_id_header || undefined,
    };

    let sent;
    if (attachments.length) {
      // the upload endpoint takes big messages; the ordinary one does not
      sent = await gmailUploadSend(buildRfc822({ ...mail, attachments }), thread ? thread.gmail_thread_id : undefined);
    } else {
      const sendBody = { raw: buildMimeMessage(mail) };
      if (thread) sendBody.threadId = thread.gmail_thread_id;
      sent = await gmailRequest('messages/send', { method: 'POST', body: sendBody });
    }

    if (!thread) {
      const { data: newThread, error: threadErr } = await supabaseAdmin
        .from('email_threads')
        .insert({ gmail_thread_id: sent.threadId, subject: finalSubject })
        .select('*').single();
      if (threadErr) throw threadErr;
      thread = newThread;
    }

    const nowIso = new Date().toISOString();
    const { error: emailErr } = await supabaseAdmin.from('emails').insert({
      thread_id: thread.id,
      gmail_message_id: sent.id,
      direction: 'outbound',
      from_address: `${profile?.full_name || 'Thomson Energy Sales'} <${GMAIL_MAILBOX}>`,
      to_addresses: to.split(',').map(s => s.trim()),
      cc_addresses: cc ? cc.split(',').map(s => s.trim()) : [],
      subject: finalSubject,
      body_text: fullBody,
      body_html: fullHtml,
      // our own sent mail keeps where each file lives in storage, so it can be opened later
      attachments: attachments.map(a => ({ part_id: null, name: a.filename, mime: a.mime, size: a.content.length, cid: null, inline: false, storage: a.storage })),
      sent_at: nowIso,
      created_by: user.id,
    });
    if (emailErr) throw emailErr;

    await supabaseAdmin.from('email_threads').update({ last_message_at: nowIso, is_read: true }).eq('id', thread.id);

    if (tagProjectId && UUID.test(tagProjectId)) {
      // already tagged to that job? leave the existing tag as it is
      await supabaseAdmin.from('email_job_links').upsert(
        { thread_id: thread.id, project_id: tagProjectId, kind: KINDS.includes(tagKind) ? tagKind : 'client', created_by: user.id },
        { onConflict: 'thread_id,project_id', ignoreDuplicates: true }
      );
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, threadId: thread.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
