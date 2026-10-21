// Gmail -> email_threads / emails sync, shared by sync-gmail.js (the every-5-minutes
// schedule) and sync-gmail-now.js (the "Sync now" buttons). sales@ first, then each
// person's own Gmail (My inbox) with whatever time is left. A personal mailbox's first
// 60 days, the clean up scan and the email agent run in mailbox-work-background.js.
//
// Netlify scheduled functions cannot be called over HTTP in production (they answer
// 403 with an empty body), which is why the buttons need their own function.
//
// sales@ uses Gmail's history API (only what's new since the last run), a page at a time:
// the starting point (api_keys google_history_id) moves on after every finished page, and
// mail TEops already has is ruled out for a whole page in one query, so a backlog always
// makes progress. Without a starting point, or if Gmail's history has aged out (it keeps
// about a week), it loads the last 14 days instead. Works within a time budget: a run
// that is out of time stops cleanly and hands the rest to mailbox-work-background.js
// (catchUpSharedMailbox, up to 15 minutes). One sales@ sync at a time (gmail_sync_lock).
//
// 20 Oct 2026: the old version saved its starting point only after a whole batch of 100,
// checked each message one by one and refetched drafts and deleted mail every run, so it
// never finished a batch inside its budget and sales@ stopped pulling in mail for days.

const { getAdminClient } = require('./require-admin');
const { gmailRequest, GMAIL_MAILBOX } = require('./google-client');
const { selfBaseUrl } = require('./site-url');
const fetch = require('node-fetch');
const { getBillLabelId, isSupplierBillMessage, startSupplierBillProcessing, INVOICE_ADDRESS } = require('./supplier-bill-intake');
const { looksLikePriceListEmail, startPriceListProcessing } = require('./price-list-intake');
const { startStatementProcessing } = require('./statement-intake');

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

// Returns { bill, priceList, inbound }: whether the message came in through invoice@ (a supplier
// bill), whether it looks like it carries a supplier price list, and whether it was received.
// mailbox: a mailboxes row; without one it is sales@.
async function processMessageId(supabaseAdmin, messageId, billLabelId, mailbox = null) {
  const personal = !!mailbox && mailbox.kind === 'personal';
  // Gmail ids are only unique within one mailbox
  let haveQuery = supabaseAdmin.from('emails').select('id, email_threads!inner(mailbox_id)').eq('gmail_message_id', messageId);
  if (mailbox) haveQuery = haveQuery.eq('email_threads.mailbox_id', mailbox.id);
  const { data: alreadyHave } = await haveQuery.limit(1);
  if (alreadyHave && alreadyHave.length) return {}; // already synced (includes ones we sent ourselves via send-gmail.js)

  const msg = await gmailRequest(`messages/${messageId}?format=full`, {}, mailbox);
  const labels = msg.labelIds || [];
  if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) return {};
  const headers = msg.payload?.headers;
  const fromRaw = headerValue(headers, 'From');
  const fromAddress = firstAddress(fromRaw);
  // sales@ also sends supplier queries as invoice@ (_shared/supplier-email.js)
  const ours = personal ? [mailbox.address.toLowerCase()] : [GMAIL_MAILBOX.toLowerCase(), INVOICE_ADDRESS];
  const direction = ours.includes(fromAddress) ? 'outbound' : 'inbound';
  const subject = headerValue(headers, 'Subject');
  const sentAt = headerValue(headers, 'Date');
  const bodyText = extractPlainText(msg.payload);
  const bodyHtml = extractHtml(msg.payload) || null;
  const attachments = extractAttachments(msg.payload);
  // invoice@ bills: hidden from the Sales tab, no "New email" notification, read by
  // process-supplier-bills-background.js instead
  const isBill = !personal && direction === 'inbound' && isSupplierBillMessage(msg, billLabelId);

  let threadQuery = supabaseAdmin.from('email_threads').select('*').eq('gmail_thread_id', msg.threadId);
  if (mailbox) threadQuery = threadQuery.eq('mailbox_id', mailbox.id);
  let { data: thread } = await threadQuery.maybeSingle();
  if (!thread) {
    const matchAddress = direction === 'inbound' ? fromAddress : firstAddress(headerValue(headers, 'To'));
    const clientId = await findClientIdForAddress(supabaseAdmin, matchAddress);
    const { data: newThread, error: threadErr } = await supabaseAdmin
      .from('email_threads')
      .insert({ gmail_thread_id: msg.threadId, subject, client_id: clientId, is_supplier_bill: isBill, mailbox_id: mailbox ? mailbox.id : undefined, is_read: personal ? !labels.includes('UNREAD') : false, is_done: personal ? !labels.includes('INBOX') : false })
      .select('*').single();
    if (threadErr && threadErr.code === '23505') {
      // another message in the same conversation was being saved at the same moment
      ({ data: thread } = await threadQuery.maybeSingle());
      if (!thread) throw threadErr;
    } else if (threadErr) {
      throw threadErr;
    } else {
      thread = newThread;
    }
  } else if (isBill && !thread.is_supplier_bill) {
    await supabaseAdmin.from('email_threads').update({ is_supplier_bill: true }).eq('id', thread.id);
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
    gmail_labels: labels,
    list_unsubscribe: headerValue(headers, 'List-Unsubscribe'),
  });
  if (emailErr) {
    if (emailErr.code === '23505') return {}; // another run saved it a moment ago
    throw emailErr;
  }

  const sentIso = sentAt ? new Date(sentAt).toISOString() : new Date().toISOString();
  const newer = !thread.last_message_at || sentIso >= thread.last_message_at;
  const patch = { subject: thread.subject || subject };
  if (newer) { patch.last_message_at = sentIso; patch.last_direction = direction; }
  if (direction === 'inbound' && newer) {
    // new mail: unread, back in the inbox, and sorted again by the email agent
    patch.is_read = personal ? !labels.includes('UNREAD') : false;
    patch.is_done = personal ? !labels.includes('INBOX') : false;
    patch.triaged_at = null;
  }
  await supabaseAdmin.from('email_threads').update(patch).eq('id', thread.id);
  return { bill: isBill, priceList: !personal && direction === 'inbound' && looksLikePriceListEmail(subject, attachments), inbound: direction === 'inbound' };
}

// Read, archived or moved back in Gmail itself (personal mailboxes): keep TEops in step.
// Only conversations TEops already has are touched (a clean up can archive thousands).
async function applyLabelChanges(supabaseAdmin, mailbox, history) {
  const changes = {};
  const note = (threadId, labelIds, added) => {
    const p = changes[threadId] = changes[threadId] || {};
    if ((labelIds || []).includes('INBOX')) p.is_done = !added;
    if ((labelIds || []).includes('UNREAD')) p.is_read = !added;
  };
  for (const h of history) {
    for (const c of (h.labelsAdded || [])) note(c.message.threadId, c.labelIds, true);
    for (const c of (h.labelsRemoved || [])) note(c.message.threadId, c.labelIds, false);
  }
  const ids = Object.keys(changes).filter((id) => Object.keys(changes[id]).length);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: known } = await supabaseAdmin.from('email_threads').select('id, gmail_thread_id').eq('mailbox_id', mailbox.id).in('gmail_thread_id', ids.slice(i, i + 200));
    for (const t of (known || [])) await supabaseAdmin.from('email_threads').update(changes[t.gmail_thread_id]).eq('id', t.id);
  }
}

// New mail in someone's own Gmail since the last run, one page of history at a time (the
// starting point moves on after each page, so a big clean up never holds the sync up).
// Their first 60 days come in through mailbox-work-background.js instead.
// Returns { synced, done, inbound }.
async function syncPersonalMailbox(supabaseAdmin, mailbox, startedAt, budgetMs) {
  if (!mailbox.history_id) return { synced: 0, done: true, inbound: 0 }; // still loading its first 60 days
  let synced = 0, inbound = 0;
  let pageToken = null;
  const start = mailbox.history_id;
  for (;;) {
    if (Date.now() - startedAt > budgetMs) return { synced, done: false, inbound };
    let page;
    try {
      page = await gmailRequest(`history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`, {}, mailbox);
    } catch (err) {
      if (err.status !== 404) throw err;
      // too long since the last sync (Gmail keeps about a week): start again from now
      const profile = await gmailRequest('profile', {}, mailbox);
      await supabaseAdmin.from('mailboxes').update({ history_id: String(profile.historyId) }).eq('id', mailbox.id);
      return { synced, done: true, inbound };
    }
    const history = page.history || [];
    const msgs = history.flatMap((h) => (h.messagesAdded || []).map((m) => m.message));
    // out of time part way through a page: the starting point stays put and the next run
    // does this page again (what is already saved is ruled out in one query)
    const ctx = { synced: 0, bills: 0, priceLists: 0, inbound: 0, billLabelId: null };
    const finished = await saveNewMessages(supabaseAdmin, msgs, mailbox, ctx, startedAt, budgetMs);
    synced += ctx.synced; inbound += ctx.inbound;
    if (!finished) return { synced, done: false, inbound };
    await applyLabelChanges(supabaseAdmin, mailbox, history);
    pageToken = page.nextPageToken;
    // move the starting point on: to the last change on this page, or to "now" at the end
    const moved = pageToken ? (history.length ? history[history.length - 1].id : null) : page.historyId;
    const patch = { last_synced_at: new Date().toISOString(), last_error: null };
    if (moved) patch.history_id = String(moved);
    await supabaseAdmin.from('mailboxes').update(patch).eq('id', mailbox.id);
    if (!pageToken) return { synced, done: true, inbound };
  }
}

// Personal mailboxes' first load, clean up and the email agent (sorting, labels, drafts).
async function startMailboxWork() {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/mailbox-work-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 8000,
    });
    if (!res.ok && res.status !== 202) console.error('mailbox work did not start:', res.status);
  } catch (err) {
    console.error('mailbox work did not start:', err.message);
  }
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

// One sales@ sync at a time. Netlify retries a scheduled run that takes over 15 seconds and
// the background catch-up may be going too; two runs would only repeat each other's work.
// The lock is an expiry time in api_keys, so a run that dies never holds it for long.
const SYNC_LOCK = 'gmail_sync_lock';
const EPOCH = new Date(0).toISOString();
async function claimSharedSync(admin, holdMs) {
  const now = new Date();
  await admin.from('api_keys').upsert({ key_name: SYNC_LOCK, key_value: EPOCH }, { onConflict: 'key_name', ignoreDuplicates: true });
  const { data } = await admin.from('api_keys').update({ key_value: new Date(now.getTime() + holdMs).toISOString() })
    .eq('key_name', SYNC_LOCK).lt('key_value', now.toISOString()).select('key_name');
  return !!(data && data.length);
}
const releaseSharedSync = (admin) => admin.from('api_keys').update({ key_value: EPOCH }).eq('key_name', SYNC_LOCK);

const SKIP_LABELS = ['DRAFT', 'SPAM', 'TRASH'];

// Saves the messages a mailbox has that TEops does not, 4 at a time. msgs: [{ id, labelIds? }].
// shared: the mailboxes row (sales@ or a personal one).
// Drafts, spam and bin are left out without fetching them (every draft save is a new message
// in Gmail's history). Returns false if time ran out first.
async function saveNewMessages(admin, msgs, shared, ctx, startedAt, budgetMs) {
  const ids = [...new Set(msgs.filter((m) => !(m.labelIds || []).some((l) => SKIP_LABELS.includes(l))).map((m) => m.id))];
  const known = new Set();
  for (let i = 0; i < ids.length; i += 150) {
    let q = admin.from('emails').select('gmail_message_id, email_threads!inner(mailbox_id)').in('gmail_message_id', ids.slice(i, i + 150));
    if (shared) q = q.eq('email_threads.mailbox_id', shared.id);
    const { data, error } = await q;
    if (error) throw error;
    (data || []).forEach((e) => known.add(e.gmail_message_id));
  }
  const todo = ids.filter((id) => !known.has(id));
  if (todo.length && ctx.billLabelId === undefined) ctx.billLabelId = await getBillLabelId(); // sales@ only; personal runs pass null
  let next = 0, outOfTime = false;
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (next < todo.length) {
      if (Date.now() - startedAt > budgetMs) { outOfTime = true; return; }
      const id = todo[next++];
      try {
        const seen = await processMessageId(admin, id, ctx.billLabelId, shared);
        if (seen.bill) ctx.bills += 1;
        if (seen.priceList) ctx.priceLists += 1;
        if (seen.inbound && !seen.bill) ctx.inbound += 1;
      } catch (err) {
        // deleted from Gmail after it was listed: skip it
        if (!/not found|404/i.test(err.message || '')) throw err;
      }
      ctx.synced += 1;
    }
  }));
  return !outOfTime;
}

// sales@ since the last run. Returns { synced, bills, priceLists, inbound, done }.
async function syncSharedMailbox(admin, shared, startedAt, budgetMs) {
  const ctx = { synced: 0, bills: 0, priceLists: 0, inbound: 0, billLabelId: undefined };
  const out = (done) => ({ synced: ctx.synced, bills: ctx.bills, priceLists: ctx.priceLists, inbound: ctx.inbound, done });
  const saveMarker = (id) => admin.from('api_keys').upsert({ key_name: 'google_history_id', key_value: String(id) });
  const { data: row } = await admin.from('api_keys').select('key_value').eq('key_name', 'google_history_id').maybeSingle();
  const start = row?.key_value;

  // no starting point, or too old for Gmail: the last 14 days, then start from "now" (taken
  // first, so nothing arriving during the load is missed; what is already saved is skipped)
  const loadRecent = async () => {
    const profile = await gmailRequest('profile');
    const list = await gmailRequest(`messages?q=${encodeURIComponent('newer_than:14d -in:drafts -in:spam -in:trash')}&maxResults=500`);
    const finished = await saveNewMessages(admin, list.messages || [], shared, ctx, startedAt, budgetMs);
    if (finished) await saveMarker(profile.historyId);
    return out(finished);
  };
  if (!start) return loadRecent();

  let pageToken = null;
  for (;;) {
    if (Date.now() - startedAt > budgetMs) return out(false);
    let page;
    try {
      page = await gmailRequest(`history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      console.error('sync-gmail: sales@ history has aged out, loading the last 14 days');
      return loadRecent();
    }
    const history = page.history || [];
    const msgs = history.flatMap((h) => (h.messagesAdded || []).map((m) => m.message));
    // out of time part way through a page: the starting point stays put and the next run
    // does this page again (what is already saved is ruled out in one query)
    if (!(await saveNewMessages(admin, msgs, shared, ctx, startedAt, budgetMs))) return out(false);
    pageToken = page.nextPageToken;
    // move the starting point on: to the last change on this page, or to "now" at the end
    const moved = pageToken ? (history.length ? history[history.length - 1].id : null) : page.historyId;
    if (moved) await saveMarker(moved);
    if (!pageToken) return out(true);
  }
}

// mailbox-work-background.js: the rest of a sales@ backlog the scheduled sync ran out of time
// for. Returns { synced, done } (done: null when another run has the lock).
async function catchUpSharedMailbox(admin, budgetMs) {
  const startedAt = Date.now();
  const { data: shared } = await admin.from('mailboxes').select('*').eq('kind', 'shared').order('created_at').limit(1).maybeSingle();
  if (!(await claimSharedSync(admin, budgetMs + 60000))) return { synced: 0, done: null };
  let r;
  try { r = await syncSharedMailbox(admin, shared, startedAt, budgetMs); } finally { await releaseSharedSync(admin); }
  if (r.bills) await startSupplierBillProcessing();
  if (r.priceLists) await startPriceListProcessing();
  return r;
}

// Returns { synced, done }. done=false means time ran out before every message was handled.
async function runSync({ budgetMs = 8000 } = {}) {
  const startedAt = Date.now();
  const supabaseAdmin = getAdminClient();

  const { data: shared } = await supabaseAdmin.from('mailboxes').select('*').eq('kind', 'shared').order('created_at').limit(1).maybeSingle();
  let sales = { synced: 0, bills: 0, priceLists: 0, inbound: 0, done: true };
  if (await claimSharedSync(supabaseAdmin, budgetMs + 60000)) {
    try { sales = await syncSharedMailbox(supabaseAdmin, shared, startedAt, budgetMs); } finally { await releaseSharedSync(supabaseAdmin); }
  } else {
    sales.done = false; // another run is pulling sales@ in right now
  }
  const synced = sales.synced, done = sales.done;
  let { bills, priceLists, inbound } = sales;
  let backfilled = 0;
  if (done) backfilled = await backfillEmails(supabaseAdmin, startedAt, budgetMs);

  // everyone's own Gmail (My inbox), with the time left
  let personalSynced = 0, personalDone = true;
  const { data: personal } = await supabaseAdmin.from('mailboxes').select('*').eq('kind', 'personal').not('connected_at', 'is', null);
  for (const mb of (personal || [])) {
    if (Date.now() - startedAt > budgetMs) { personalDone = false; break; }
    try {
      const r = await syncPersonalMailbox(supabaseAdmin, mb, startedAt, budgetMs);
      personalSynced += r.synced; inbound += r.inbound;
      if (!r.done) personalDone = false;
    } catch (err) {
      console.error(`sync-gmail: ${mb.address} failed:`, err.message);
      await supabaseAdmin.from('mailboxes').update({ last_error: String(err.message).slice(0, 300) }).eq('id', mb.id);
    }
  }
  // the email agent sorts new mail; personal first loads and clean ups carry on in the background
  const { count: unsorted } = await supabaseAdmin.from('email_threads').select('id, mailboxes!inner(connected_at)', { count: 'exact', head: true })
    .is('triaged_at', null).eq('is_supplier_bill', false).not('mailboxes.connected_at', 'is', null)
    .gt('last_message_at', new Date(Date.now() - 60 * 86400000).toISOString());
  const pendingWork = (personal || []).some((mb) => !mb.backfill_done_at || (mb.cleanup_started_at && !mb.cleanup_done_at) || mb.cleanup_read_older_days);
  // Also once an hour even with nothing to do, so its heartbeat stays fresh and the 5am digest
  // doesn't report the email agent as down after a quiet night (bug review F14).
  const { data: hb } = await supabaseAdmin.from('agent_heartbeats').select('last_ok_at').eq('agent', 'mailbox-work').maybeSingle();
  const stale = !hb?.last_ok_at || Date.now() - new Date(hb.last_ok_at).getTime() > 50 * 60000;
  // also when sales@ is behind: the background run carries on with the backlog
  if (inbound || unsorted || pendingWork || stale || !done) await startMailboxWork();
  // Supplier bills are read in the background (a PDF takes longer than this function gets).
  // Started when a bill came in, when some are still waiting, and once an hour as a safety net.
  const { count: waiting } = await supabaseAdmin.from('supplier_bill_inbox').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (bills || waiting || new Date().getMinutes() < 5) await startSupplierBillProcessing();
  // emailed price lists (from sales@ or invoice@): same idea, started on a likely one, while any are part read, and hourly
  const { count: listsWaiting } = await supabaseAdmin.from('price_list_imports').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (priceLists || listsWaiting || new Date().getMinutes() < 5) await startPriceListProcessing();
  // bill checks and statements: after the bill reader has had a go, so hourly is soon enough
  if (new Date().getMinutes() >= 30 && new Date().getMinutes() < 35) await startStatementProcessing();
  console.log(`sync-gmail: sales@ ${synced} new message(s)${done ? '' : ' (more waiting, handed to the background run)'}, ${bills} supplier bill(s), filled in ${backfilled} older email(s).`);
  return { synced: synced + personalSynced, done: done && personalDone, backfilled, bills, priceLists };
}

module.exports = { runSync, catchUpSharedMailbox, processMessageId, startMailboxWork, headerValue, firstAddress, extractHtml, extractAttachments, extractPlainText };
