// POST or scheduled /.netlify/functions/sync-gmail
// Pulls new mail for sales@thomsonenergy.com.au into email_threads/emails.
// Runs on a 5-minute schedule (see netlify.toml) and can also be triggered
// directly by the "Sync now" button in Settings. Not auth-gated - same
// convention as this app's other scheduled function
// (archive-completed-jobs.js has none either): nothing in the response
// body reveals mail content to whoever calls it, it only writes to our
// own DB, so an unauthenticated trigger can't leak anything, just cause
// an extra sync.
//
// Uses Gmail's history API for incremental sync (only what's new since
// the last run) once we have a starting point; falls back to listing
// recent messages to bootstrap that starting point on the very first run,
// or if Gmail's history has aged out (it only keeps ~1 week).

const { getAdminClient } = require('./_shared/require-admin');
const { gmailRequest, GMAIL_MAILBOX } = require('./_shared/google-client');

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

exports.handler = async () => {
  try {
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

    let synced = 0;
    for (const id of messageIds) {
      await processMessageId(supabaseAdmin, id);
      synced += 1;
    }

    if (newHistoryId) {
      await supabaseAdmin.from('api_keys').upsert({ key_name: 'google_history_id', key_value: String(newHistoryId) });
    }

    console.log(`sync-gmail: processed ${synced} message(s).`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, synced }) };
  } catch (err) {
    console.error('sync-gmail failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
