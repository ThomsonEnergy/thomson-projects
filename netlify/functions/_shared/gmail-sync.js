// Gmail -> email_threads / emails sync, shared by sync-gmail.js (the every-5-minutes
// schedule) and sync-gmail-now.js (the "Sync now" buttons).
//
// Netlify scheduled functions cannot be called over HTTP in production (they answer
// 403 with an empty body), which is why the buttons need their own function.
//
// Uses Gmail's history API for incremental sync (only what's new since the last run)
// once we have a starting point; falls back to listing recent messages to bootstrap
// that starting point on the very first run, or if Gmail's history has aged out (it
// only keeps about a week). Works within a time budget: if it runs out of time it
// stops cleanly and does NOT move the starting point on, so the next run carries on
// with the rest (anything already saved is skipped quickly).

const { getAdminClient } = require('./require-admin');
const { gmailRequest, GMAIL_MAILBOX } = require('./google-client');

function headerValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Gmail messages can be simple (body directly on payload) or multipart
// (nested parts, possibly recursively for e.g. multipart/alternative
// containing multipart/related). Walks the tree for the first text/plain
// part it finds.
function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  if (!payload.parts && payload.body?.data && payload.mimeType !== 'text/html') {
    return decodeBase64Url(payload.body.data);
  }
  return '';
}

// The formatted (HTML) version of the message, if it has one.
function extractHtml(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractHtml(part);
    if (found) return found;
  }
  return '';
}

// Attachments and inline images (the ones a formatted email points at with cid:).
// Only describes them: the files themselves are fetched from Gmail when someone opens one.
function extractAttachments(payload) {
  const out = [];
  (function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const headers = part.headers || [];
    const cidRaw = headerValue(headers, 'Content-ID');
    const disposition = (headerValue(headers, 'Content-Disposition') || '').toLowerCase();
    const isBodyText = (mime === 'text/plain' || mime === 'text/html') && !part.filename;
    if (!mime.startsWith('multipart/') && !isBodyText && (part.filename || cidRaw) && (part.body?.attachmentId || part.body?.data)) {
      out.push({
        part_id: part.partId || null,
        name: part.filename || (cidRaw ? 'inline-' + cidRaw.replace(/[<>]/g, '').split('@')[0] : 'attachment'),
        mime,
        size: part.body?.size || 0,
        cid: cidRaw ? cidRaw.replace(/[<>\s]/g, '') : null,
        inline: !!cidRaw && !disposition.startsWith('attachment'),
      });
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return out;
}

function parseAddressList(headerVal) {
  if (!headerVal) return [];
  return headerVal.split(',').map(s => s.trim()).filter(Boolean);
}
function firstAddress(headerVal) {
  const match = (headerVal || '').match(/<([^>]+)>/);
  return (match ? match[1] : headerVal || '').trim().toLowerCase();
}

async function findClientIdForAddress(supabaseAdmin, address) {
  if (!address) return null;
  const { data: client } = await supabaseAdmin.from('clients').select('id').ilike('email', address).maybeSingle();
  if (client) return client.id;
  const { data: contact } = await supabaseAdmin.from('client_contacts').select('client_id').ilike('email', address).maybeSingle();
  return contact?.client_id || null;
}

async function processMessageId(supabaseAdmin, messageId) {
  const { data: alreadyHave } = await supabaseAdmin.from('emails').select('id').eq('gmail_message_id', messageId).maybeSingle();
  if (alreadyHave) return; // already synced (includes ones we sent ourselves via send-gmail.js)

  const msg = await gmailRequest(`messages/${messageId}?format=full`);
  const headers = msg.payload?.headers;
  const fromRaw = headerValue(headers, 'From');
  const fromAddress = firstAddress(fromRaw);
  const direction = fromAddress === GMAIL_MAILBOX.toLowerCase() ? 'outbound' : 'inbound';
  const subject = headerValue(headers, 'Subject');
  const sentAt = headerValue(headers, 'Date');
  const bodyText = extractPlainText(msg.payload);
  const bodyHtml = extractHtml(msg.payload) || null;
  const attachments = extractAttachments(msg.payload);

  let { data: thread } = await supabaseAdmin.from('email_threads').select('*').eq('gmail_thread_id', msg.threadId).maybeSingle();
  if (!thread) {
    const matchAddress = direction === 'inbound' ? fromAddress : firstAddress(headerValue(headers, 'To'));
    const clientId = await findClientIdForAddress(supabaseAdmin, matchAddress);
    const { data: newThread, error: threadErr } = await supabaseAdmin
      .from('email_threads')
      .insert({ gmail_thread_id: msg.threadId, subject, client_id: clientId })
      .select('*').single();
    if (threadErr) throw threadErr;
    thread = newThread;
  }

  const { error: emailErr } = await supabaseAdmin.from('emails').insert({
    thread_id: thread.id,
    gmail_message_id: messageId,
    direction,
    from_address: fromRaw,
    to_addresses: parseAddressList(headerValue(headers, 'To')),
    cc_addresses: parseAddressList(headerValue(headers, 'Cc')),
    subject,
    body_text: bodyText,
    body_html: bodyHtml,
    attachments,
    message_id_header: headerValue(headers, 'Message-ID') || headerValue(headers, 'Message-Id'),
    sent_at: sentAt ? new Date(sentAt).toISOString() : new Date().toISOString(),
  });
  if (emailErr) throw emailErr;

  await supabaseAdmin.from('email_threads').update({
    last_message_at: sentAt ? new Date(sentAt).toISOString() : new Date().toISOString(),
    subject: thread.subject || subject,
    is_read: direction === 'inbound' ? false : thread.is_read,
  }).eq('id', thread.id);
}


// Mail synced before the formatted version and attachment list were kept has
// attachments = null: fill those in, newest first, with whatever time is left.
async function backfillEmails(supabaseAdmin, startedAt, budgetMs) {
  const { data: pending } = await supabaseAdmin.from('emails').select('id, gmail_message_id').is('attachments', null).order('sent_at', { ascending: false }).limit(30);
  let filled = 0;
  for (const e of (pending || [])) {
    if (Date.now() - startedAt > budgetMs) break;
    try {
      const msg = await gmailRequest(`messages/${e.gmail_message_id}?format=full`);
      await supabaseAdmin.from('emails').update({ body_html: extractHtml(msg.payload) || null, attachments: extractAttachments(msg.payload) }).eq('id', e.id);
      filled += 1;
    } catch (err) {
      // a message deleted from Gmail can never be filled in: mark it done so it is not retried forever
      if (/404|not found/i.test(err.message || '')) await supabaseAdmin.from('emails').update({ attachments: [] }).eq('id', e.id);
      else console.error('backfill failed for', e.gmail_message_id, err.message);
    }
  }
  return filled;
}

// Returns { synced, done }. done=false means time ran out before every message was handled.
async function runSync({ budgetMs = 8000 } = {}) {
  const startedAt = Date.now();
  const supabaseAdmin = getAdminClient();

  const { data: historyRow } = await supabaseAdmin.from('api_keys').select('key_value').eq('key_name', 'google_history_id').maybeSingle();
  const startHistoryId = historyRow?.key_value;

  let messageIds = [];
  let newHistoryId = null;

  if (startHistoryId) {
    try {
      const history = await gmailRequest(`history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`);
      messageIds = (history.history || []).flatMap(h => (h.messagesAdded || []).map(m => m.message.id));
      newHistoryId = history.historyId;
    } catch (err) {
      // historyId too old (Gmail only keeps ~1 week) - fall through to the bootstrap path below.
      console.error('history.list failed, falling back to messages.list:', err.message);
    }
  }

  if (!newHistoryId) {
    const list = await gmailRequest('messages?maxResults=50');
    messageIds = (list.messages || []).map(m => m.id);
    const profile = await gmailRequest('profile');
    newHistoryId = profile.historyId;
  }

  messageIds = [...new Set(messageIds)];
  let synced = 0, done = true;
  for (const id of messageIds) {
    if (Date.now() - startedAt > budgetMs) { done = false; break; }
    await processMessageId(supabaseAdmin, id);
    synced += 1;
  }

  if (done && newHistoryId) {
    await supabaseAdmin.from('api_keys').upsert({ key_name: 'google_history_id', key_value: String(newHistoryId) });
  }
  let backfilled = 0;
  if (done) backfilled = await backfillEmails(supabaseAdmin, startedAt, budgetMs);
  console.log(`sync-gmail: processed ${synced} of ${messageIds.length} message(s)${done ? '' : ' (out of time, will carry on next run)'}, filled in ${backfilled} older email(s).`);
  return { synced, done, total: messageIds.length, backfilled };
}

module.exports = { runSync, extractHtml, extractAttachments, extractPlainText };
