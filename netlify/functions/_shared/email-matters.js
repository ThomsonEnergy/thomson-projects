// Postie's older-conversations pass (item 56): a label for every conversation with no job.
// Called by runEmailAgent (email-agent.js) after the sort and before the label sweeps, for a
// mailbox with auto_labels on, with whatever time is left. New mail is labelled by the sort itself (email-agent.js
// triageBatch); this pass covers what was already there.
//
//   1. groupOldSuggestions: once, the label suggestions waiting from before item 56 (26 on
//      production, many the same matter worded differently) are grouped by matter, made into
//      labels (or matched to an existing one), and their conversations filed. A suggestion in
//      no group (a staff member's personal matter) is cleared, as the label rules never make
//      those labels, so this runs once. Remove after 30 Nov 2026.
//   2. fileOldConversations: the last 60 days, a batch per run, newest first. A conversation
//      (mail both ways, 2 or more emails) with no job and no label goes through the same label
//      pass and rules as new mail. Every thread looked at is marked suggested_label '' (or
//      given a suggestion) so it is read once; new mail on it is handled by the sort.
//
// A new label asks for the 60 day sweep (makeAgentLabel), so the rest of that trail is filed
// too. Writes email_labels, email_thread_labels, email_threads.suggested_label, Gmail labels.

const {
  isConversation, applyLabelPick, fileUnder, makeAgentLabel, chooseLabels, messagesFor, threadText, findLabel,
  claude, textOf, addUsage, LABEL_MODEL,
} = require('./email-agent');
const { GROUP_PROMPT } = require('../../../agents/prompts/postie-labels.js');

const BATCH = 20;
const DAYS = 60;
const GROUP_BEFORE = '2026-11-10T00:00:00Z'; // suggestions from before item 56 shipped

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'An existing label name exactly, or a new "Who: what" name.' },
          about: { type: 'string', description: 'One sentence on what belongs under it. "" for an existing label.' },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'about', 'suggestions'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
};

const whoFor = (mailbox, ctx) => (mailbox.kind === 'shared'
  ? 'the shared sales@thomsonenergy.com.au inbox (enquiries, quotes, clients, builders, suppliers)'
  : `the work inbox of ${ctx.ownerName} (${mailbox.address})`);

async function labelledIds(admin, ids) {
  const [{ data: labelled }, { data: jobs }] = await Promise.all([
    admin.from('email_thread_labels').select('thread_id').in('thread_id', ids),
    admin.from('email_job_links').select('thread_id').in('thread_id', ids),
  ]);
  return { labelled: new Set((labelled || []).map((r) => r.thread_id)), withJob: new Set((jobs || []).map((r) => r.thread_id)) };
}

async function groupOldSuggestions(admin, apiKey, mailbox, ctx, usage) {
  if (Date.now() > Date.parse('2026-11-30T00:00:00Z')) return { grouped: 0 };
  const { data: threads } = await admin.from('email_threads').select('id, gmail_thread_id, suggested_label')
    .eq('mailbox_id', mailbox.id).not('suggested_label', 'is', null).neq('suggested_label', '').lt('triaged_at', GROUP_BEFORE).limit(500);
  if (!threads || !threads.length) return { grouped: 0 };
  const names = [...new Set(threads.map((t) => t.suggested_label))];
  const labelLines = ctx.labels.map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ''}`).join('\n') || '(none yet)';
  const data = await claude(apiKey, {
    model: LABEL_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: GROUP_SCHEMA } },
    system: GROUP_PROMPT.replace('{{who}}', () => whoFor(mailbox, ctx)).replace('{{labels}}', () => labelLines),
    messages: [{ role: 'user', content: `Suggested label names:\n${names.map((n) => `- ${n} (${threads.filter((t) => t.suggested_label === n).length})`).join('\n')}` }],
  });
  addUsage(usage, data);
  let groups = [];
  try { groups = JSON.parse(textOf(data)).groups || []; } catch { return { grouped: 0 }; }
  let grouped = 0;
  const filedIds = new Set();
  for (const g of groups) {
    const members = threads.filter((t) => (g.suggestions || []).includes(t.suggested_label));
    if (!members.length || !String(g.name || '').trim()) continue;
    const label = findLabel(ctx.labels, g.name) || await makeAgentLabel(admin, mailbox, ctx, String(g.name).replace(/—/g, ','), String(g.about || '').replace(/—/g, ','));
    if (!label) continue;
    for (const t of members) {
      if (await fileUnder(admin, mailbox, t, label)) { filedIds.add(t.id); grouped += 1; }
    }
  }
  // filed ones and ones in no group are done: '' so neither this nor the older pass reads them again
  const done = threads.filter((t) => filedIds.has(t.id) || !groups.some((g) => (g.suggestions || []).includes(t.suggested_label)));
  if (done.length) await admin.from('email_threads').update({ suggested_label: '' }).in('id', done.map((t) => t.id));
  return { grouped };
}

async function fileOldConversations(admin, apiKey, mailbox, ctx, usage, deadline) {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  let filed = 0, read = 0, more = false; // more: a full batch was left when time ran out
  while (Date.now() < deadline) {
    const { data: threads } = await admin.from('email_threads').select('id, gmail_thread_id, subject, section')
      .eq('mailbox_id', mailbox.id).is('suggested_label', null).eq('is_supplier_bill', false).not('triaged_at', 'is', null)
      .gt('last_message_at', since).order('last_message_at', { ascending: false }).limit(BATCH);
    if (!threads || !threads.length) break;
    const ids = threads.map((t) => t.id);
    const [{ labelled, withJob }, msgs] = await Promise.all([labelledIds(admin, ids), messagesFor(admin, ids)]);
    const items = threads
      .filter((t) => t.section !== 'updates' && !labelled.has(t.id) && !withJob.has(t.id) && isConversation(msgs[t.id]))
      .map((t) => ({ id: t.id, text: threadText(t, msgs[t.id]), conversation: true }));
    const picks = items.length ? await chooseLabels(apiKey, { who: whoFor(mailbox, ctx), labels: ctx.labels, items }, usage) : {};
    for (const t of threads) {
      const suggested = picks[t.id] ? await applyLabelPick(admin, mailbox, ctx, t, picks[t.id]) : null;
      await admin.from('email_threads').update({ suggested_label: suggested || '' }).eq('id', t.id);
    }
    const { count } = await admin.from('email_thread_labels').select('thread_id', { count: 'exact', head: true }).in('thread_id', items.map((i) => i.id));
    filed += count || 0;
    read += threads.length;
    more = threads.length === BATCH;
    if (!more) break;
  }
  return { filed, read, more };
}

// One mailbox: the old suggestions first (once), then older conversations until the deadline.
async function fileMatters(admin, apiKey, mailbox, ctx, usage, deadline) {
  if (!mailbox.auto_labels || Date.now() > deadline) return { grouped: 0, filed: 0, read: 0, more: false };
  const g = await groupOldSuggestions(admin, apiKey, mailbox, ctx, usage);
  const f = await fileOldConversations(admin, apiKey, mailbox, ctx, usage, deadline);
  return { grouped: g.grouped, ...f };
}

module.exports = { fileMatters };
