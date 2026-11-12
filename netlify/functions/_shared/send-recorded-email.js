// Sends an email through Gmail and records it in TEops (email_threads, emails, email_job_links),
// so it shows in the Inbox and on the job's Emails tab. The one send-and-record path: send-gmail.js
// (a person pressing Send) and the booking emails (schedule-client.js, pick-time.js) all use it.
//
// sendRecordedEmail(admin, opts) with the pieces already resolved:
//   mailbox (mailboxes row), fromName, fromAddress, senderId (profiles id or null), signature
//   ({ text, html }), to (comma separated string), cc, subject, bodyText (may hold
//   [[button: Label | url]] lines), attachments (from send-gmail's loadAttachments, or []),
//   thread (email_threads row to reply in, or null), lastMessage (emails row for In-Reply-To, or
//   null), tagProjectId, tagKind ('client' by default).
// Returns { thread, emailId, gmailMessageId, subject }.
//
// sendAsUser(admin, { userId, to, cc, subject, bodyText, tagProjectId, tagKind }) is the short form
// for a new email from sales@ in a staff member's name with their signature.

const { gmailRequest, gmailUploadSend, GMAIL_MAILBOX } = require('./google-client');
const { sharedMailbox } = require('./mailboxes');
const { buildMimeMessage, buildRfc822 } = require('./build-mime-message');
const { signatureForUser, plainTextToHtml, plainTextWithoutButtons, withoutSignOff } = require('./build-email-signature');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['materials_quote', 'client', 'supplier', 'other'];
const splitAddresses = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function sendRecordedEmail(admin, opts) {
  const { mailbox, fromName, fromAddress, senderId, signature, to, cc, subject, bodyText, thread: threadIn, lastMessage, tagProjectId, tagKind } = opts;
  const attachments = opts.attachments || [];
  if (!mailbox || !to || !subject || !bodyText) throw new Error('to, subject and bodyText are required');
  // a sign off at the end of the reply goes: the signature adds "Kind regards," and the name
  const body = withoutSignOff(bodyText, fromName);
  const fullBody = `${plainTextWithoutButtons(body)}\n\n${signature.text}`;
  const fullHtml = `${plainTextToHtml(body)}${signature.html}`;
  let thread = threadIn || null;
  const finalSubject = thread && !/^re:/i.test(subject) ? `Re: ${subject}` : subject;
  const mail = {
    fromName, fromAddress, to, cc, subject: finalSubject, bodyText: fullBody, bodyHtml: fullHtml,
    inReplyTo: lastMessage?.message_id_header || undefined,
    references: lastMessage?.message_id_header || undefined,
  };

  let sent;
  if (attachments.length) {
    // the upload endpoint takes big messages; the ordinary one does not
    sent = await gmailUploadSend(buildRfc822({ ...mail, attachments }), thread ? thread.gmail_thread_id : undefined, mailbox);
  } else {
    const sendBody = { raw: buildMimeMessage(mail) };
    if (thread) sendBody.threadId = thread.gmail_thread_id;
    sent = await gmailRequest('messages/send', { method: 'POST', body: sendBody }, mailbox);
  }

  if (!thread) {
    const { data: newThread, error: threadErr } = await admin
      .from('email_threads')
      .insert({ gmail_thread_id: sent.threadId, subject: finalSubject, mailbox_id: mailbox.id, is_read: true, section: 'other', section_by: 'person', triaged_at: new Date().toISOString() })
      .select('*').single();
    if (threadErr) throw threadErr;
    thread = newThread;
  }

  // Keep the Message-ID Gmail gave this email, so the next reply in the thread can point at it
  // (In-Reply-To / References) and stays threaded for the client. Best effort.
  let sentMessageId = null;
  try {
    const meta = await gmailRequest(`messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`, {}, mailbox);
    sentMessageId = ((meta.payload && meta.payload.headers) || []).find((h) => /^message-id$/i.test(h.name))?.value || null;
  } catch (e) { console.error('send-recorded-email: could not read the Message-ID', e.message); }

  const nowIso = new Date().toISOString();
  const { data: emailRow, error: emailErr } = await admin.from('emails').insert({
    thread_id: thread.id,
    gmail_message_id: sent.id,
    message_id_header: sentMessageId,
    direction: 'outbound',
    from_address: `${fromName} <${fromAddress}>`,
    to_addresses: splitAddresses(to),
    cc_addresses: splitAddresses(cc),
    subject: finalSubject,
    body_text: fullBody,
    body_html: fullHtml,
    // our own sent mail keeps where each file lives in storage, so it can be opened later
    attachments: attachments.map((a) => ({ part_id: null, name: a.filename, mime: a.mime, size: a.content.length, cid: null, inline: false, storage: a.storage })),
    sent_at: nowIso,
    created_by: senderId || null,
  }).select('id').single();
  if (emailErr) throw emailErr;

  // sending claims an unclaimed conversation for the sender, so the team sees who has it
  const claim = !thread.assigned_to && senderId ? { assigned_to: senderId, assigned_by: senderId, assigned_at: nowIso } : {};
  await admin.from('email_threads').update({ last_message_at: nowIso, last_direction: 'outbound', is_read: true, ...claim }).eq('id', thread.id);
  // an email to a person answers their other open Priority conversations too (item 80)
  try {
    await answerOpenThreads(admin, { mailbox, threadId: thread.id, recipients: [...splitAddresses(to), ...splitAddresses(cc)], senderId, emailId: emailRow.id, at: nowIso });
  } catch (e) { console.error('send-recorded-email: could not mark other conversations answered', e.message); }

  if (tagProjectId && UUID.test(tagProjectId)) {
    // already tagged to that job? leave the existing tag as it is
    await admin.from('email_job_links').upsert(
      { thread_id: thread.id, project_id: tagProjectId, kind: KINDS.includes(tagKind) ? tagKind : 'client', created_by: senderId || null },
      { onConflict: 'thread_id,project_id', ignoreDuplicates: true }
    );
  }

  return { thread, emailId: emailRow.id, gmailMessageId: sent.id, subject: finalSubject };
}

// Any email to a person answers their open Priority conversations in this inbox, even a new
// email (a booking, a quote) rather than a reply in their own thread. Those conversations get
// answered_at, answered_by and the email that did it, leave Priority ("You emailed them ...,
// waiting on them") and are claimed by the sender when nobody was on them. The Gmail sync
// clears the mark when the person writes back (gmail-sync.js).
const addrOnly = (raw) => { const m = String(raw || '').match(/<([^>]+)>/); return (m ? m[1] : String(raw || '')).trim().toLowerCase(); };
async function answerOpenThreads(admin, { mailbox, threadId, recipients, senderId, emailId, at }) {
  const addrs = [...new Set(recipients.map(addrOnly).filter(Boolean))];
  if (!addrs.length) return;
  const { data: open } = await admin.from('email_threads').select('id, assigned_to')
    .eq('mailbox_id', mailbox.id).eq('section', 'priority').eq('last_direction', 'inbound').eq('is_done', false).is('answered_at', null)
    .neq('id', threadId).limit(300);
  if (!open || !open.length) return;
  const { data: mails } = await admin.from('emails').select('thread_id, from_address')
    .in('thread_id', open.map((t) => t.id)).eq('direction', 'inbound').order('sent_at', { ascending: false }).limit(3000);
  const from = {};
  for (const e of (mails || [])) if (!from[e.thread_id]) from[e.thread_id] = addrOnly(e.from_address);
  const hit = open.filter((t) => addrs.includes(from[t.id]));
  if (!hit.length) return;
  const mark = { answered_at: at, answered_by: senderId || null, answered_email_id: emailId };
  const unclaimed = hit.filter((t) => !t.assigned_to && senderId).map((t) => t.id);
  const claimed = hit.filter((t) => !unclaimed.includes(t.id)).map((t) => t.id);
  if (unclaimed.length) await admin.from('email_threads').update({ ...mark, assigned_to: senderId, assigned_by: senderId, assigned_at: at }).in('id', unclaimed);
  if (claimed.length) await admin.from('email_threads').update(mark).in('id', claimed);
}

// A new email from sales@ in a staff member's name (their signature), recorded on the job.
async function sendAsUser(admin, { userId, to, cc, subject, bodyText, tagProjectId, tagKind }) {
  const [{ data: profile }, mailbox, signature] = await Promise.all([
    admin.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
    sharedMailbox(admin),
    signatureForUser(admin, { id: userId }),
  ]);
  if (!mailbox) throw new Error('sales@ is not connected.');
  return sendRecordedEmail(admin, {
    mailbox, fromName: profile?.full_name || 'Thomson Energy Sales', fromAddress: GMAIL_MAILBOX, senderId: userId, signature,
    to, cc, subject, bodyText, attachments: [], thread: null, lastMessage: null, tagProjectId, tagKind: tagKind || 'client',
  });
}

module.exports = { sendRecordedEmail, sendAsUser, KINDS, UUID };
