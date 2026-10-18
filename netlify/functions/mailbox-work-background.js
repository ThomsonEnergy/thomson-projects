// POST /.netlify/functions/mailbox-work-background
//
// Background function (up to 15 minutes). Started by the Gmail sync (_shared/gmail-sync.js)
// when new mail came in or work is waiting, by a new Gmail connection, and by the Clean up
// buttons. Calling it with no body is harmless: it only works through what is waiting.
//   1. A newly connected My inbox: its last 60 days of mail into TEops.
//   2. Clean up: the whole-inbox scan by sender, Sparky's suggestions, then the archive /
//      read / unsubscribe taps (_shared/mailbox-cleanup.js).
//   3. The email agent: sections, labels, job tags and drafts (_shared/email-agent.js).
// One run per mailbox at a time (mailboxes.busy_until). Starts itself again if time runs out.

const { getAdminClient } = require('./_shared/require-admin');
const { gmailRequest } = require('./_shared/google-client');
const { processMessageId, startMailboxWork } = require('./_shared/gmail-sync');
const { scanInbox, suggestForSenders, runQueuedActions } = require('./_shared/mailbox-cleanup');
const { runEmailAgent } = require('./_shared/email-agent');
const { runAgent } = require('./_shared/agent-log');

const BUDGET_MS = 12 * 60 * 1000;
const BACKFILL_QUERY = 'newer_than:60d -in:spam -in:trash -in:drafts -in:chats';

async function claim(admin, mailbox) {
  const now = new Date();
  const { data } = await admin.from('mailboxes').update({ busy_until: new Date(now.getTime() + 14 * 60000).toISOString() })
    .eq('id', mailbox.id).or(`busy_until.is.null,busy_until.lt.${now.toISOString()}`).select('*').maybeSingle();
  return data;
}
const release = (admin, mailbox) => admin.from('mailboxes').update({ busy_until: null }).eq('id', mailbox.id);

// A newly connected mailbox: the last 60 days, a page of 100 at a time, carrying on where it stopped.
async function backfill(admin, mailbox, startedAt) {
  let mb = mailbox;
  if (!mb.history_id) {
    // new mail from now on comes through the normal sync
    const profile = await gmailRequest('profile', {}, mb);
    await admin.from('mailboxes').update({ history_id: String(profile.historyId) }).eq('id', mb.id);
    mb = { ...mb, history_id: String(profile.historyId) };
  }
  let loaded = 0;
  while (Date.now() - startedAt < BUDGET_MS) {
    const list = await gmailRequest(`messages?q=${encodeURIComponent(BACKFILL_QUERY)}&maxResults=100${mb.backfill_page_token ? `&pageToken=${mb.backfill_page_token}` : ''}`, {}, mb);
    // 5 at a time: a 60 day load is thousands of emails
    const ids = (list.messages || []).map((m) => m.id);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try { await processMessageId(admin, id, null, mb); } catch (err) {
          if (err.status !== 404 && !/not found/i.test(err.message || '')) throw err;
        }
        loaded += 1;
      }
    }));
    const patch = { backfill_page_token: list.nextPageToken || null };
    if (!list.nextPageToken) patch.backfill_done_at = new Date().toISOString();
    await admin.from('mailboxes').update(patch).eq('id', mb.id);
    mb = { ...mb, ...patch };
    if (!list.nextPageToken) break;
  }
  return { loaded, done: !!mb.backfill_done_at };
}

exports.handler = () => runAgent('mailbox-work', async () => {
  const admin = getAdminClient();
  const startedAt = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const parts = [];
  let more = false;

  const { data: mailboxes } = await admin.from('mailboxes').select('*').not('connected_at', 'is', null).order('kind', { ascending: false });
  for (const row of (mailboxes || [])) {
    if (Date.now() - startedAt > BUDGET_MS) { more = true; break; }
    const mb = await claim(admin, row);
    if (!mb) continue; // another run has it
    try {
      if (mb.kind === 'personal' && !mb.backfill_done_at) {
        // sort what has loaded so far first (newest first), so the inbox is usable while the rest loads
        const early = await runEmailAgent(admin, mb, { budgetMs: 3 * 60000 });
        usage.input_tokens += early.usage.input_tokens; usage.output_tokens += early.usage.output_tokens;
        if (early.sorted) parts.push(`${mb.address}: ${early.sorted} sorted, ${early.priority} need a reply, ${early.drafted} drafted`);
        const r = await backfill(admin, mb, startedAt);
        if (r.loaded) parts.push(`${mb.address}: ${r.loaded} emails loaded`);
        if (!r.done) more = true;
      }
      if (mb.cleanup_started_at && !mb.cleanup_done_at && Date.now() - startedAt < BUDGET_MS) {
        const r = await scanInbox(admin, mb, { startedAt, budgetMs: BUDGET_MS });
        if (r.scanned) parts.push(`${mb.address}: ${r.scanned} scanned for clean up`);
        if (!r.done) more = true;
      }
      if (mb.cleanup_started_at && Date.now() - startedAt < BUDGET_MS) {
        const fresh = (await admin.from('mailboxes').select('*').eq('id', mb.id).single()).data;
        if (fresh.cleanup_done_at) await suggestForSenders(admin, fresh, usage);
        const q = await runQueuedActions(admin, fresh, { startedAt, budgetMs: BUDGET_MS });
        if (q.done) parts.push(`${mb.address}: ${q.done} clean up actions`);
        const { count } = await admin.from('mailbox_cleanup_senders').select('sender', { count: 'exact', head: true }).eq('mailbox_id', mb.id).not('queued_action', 'is', null);
        if (count || (await admin.from('mailboxes').select('cleanup_read_older_days').eq('id', mb.id).single()).data?.cleanup_read_older_days) more = true;
      }
      if (Date.now() - startedAt < BUDGET_MS) {
        const r = await runEmailAgent(admin, mb, { budgetMs: Math.max(0, BUDGET_MS - (Date.now() - startedAt)) });
        usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
        if (r.sorted) parts.push(`${mb.address}: ${r.sorted} sorted, ${r.priority} need a reply, ${r.drafted} drafted`);
      }
    } catch (err) {
      console.error(`mailbox work for ${mb.address} failed:`, err.message);
      await admin.from('mailboxes').update({ last_error: String(err.message).slice(0, 300) }).eq('id', mb.id);
      parts.push(`${mb.address}: ${String(err.message).slice(0, 120)}`);
    } finally {
      await release(admin, mb);
    }
  }
  if (more) await startMailboxWork();
  return {
    quiet: !parts.length,
    summary: parts.join('; ') || 'Nothing waiting',
    details: { more },
    usage,
  };
});
