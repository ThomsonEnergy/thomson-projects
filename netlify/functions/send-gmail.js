// POST /.netlify/functions/send-gmail
// Body: { to, cc, subject, bodyText, replyToThreadId? }
// Any active staff member. Sends as sales@thomsonenergy.com.au, with the
// sending user's own name in the From display name and their saved
// signature appended to the body - so the client sees a real person's
// name even though the address is always sales@, matching what Jasper
// asked for. Sends via the Gmail API (not SMTP) specifically so the sent
// message shows up correctly threaded in the real Gmail Sent folder too,
// not just in this app.

const { requireActiveUser } = require('./_shared/require-active-user');
const { gmailRequest, GMAIL_MAILBOX } = require('./_shared/google-client');
const { buildMimeMessage } = require('./_shared/build-mime-message');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { to, cc, subject, bodyText, replyToThreadId } = JSON.parse(event.body || '{}');
    if (!to || !subject || !bodyText) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'to, subject and bodyText are required' }) };
    }

    const { supabaseAdmin, user } = auth;
    const { data: profile } = await supabaseAdmin.from('profiles').select('full_name, email_signature').eq('id', user.id).single();
    const fullBody = profile?.email_signature ? `${bodyText}\n\n${profile.email_signature}` : bodyText;

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
    const raw = buildMimeMessage({
      fromName: profile?.full_name || 'Thomson Energy Sales',
      fromAddress: GMAIL_MAILBOX,
      to,
      cc,
      subject: finalSubject,
      bodyText: fullBody,
      inReplyTo: lastMessage?.message_id_header || undefined,
      references: lastMessage?.message_id_header || undefined,
    });

    const sendBody = { raw };
    if (thread) sendBody.threadId = thread.gmail_thread_id;
    const sent = await gmailRequest('messages/send', { method: 'POST', body: sendBody });

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
      sent_at: nowIso,
      created_by: user.id,
    });
    if (emailErr) throw emailErr;

    await supabaseAdmin.from('email_threads').update({ last_message_at: nowIso, is_read: true }).eq('id', thread.id);

    return { statusCode: 200, body: JSON.stringify({ ok: true, threadId: thread.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
