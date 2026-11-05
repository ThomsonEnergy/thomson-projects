// Postie's older-conversations pass (item 56): a label for every conversation with no job.
// Called by runEmailAgent (email-agent.js) after the sort and the label sweeps, for a mailbox
// with auto_labels on, with whatever time is left. New mail is labelled by the sort itself
// (email-agent.js triageBatch); this pass covers what was already there.
//
//   1. groupOldSuggestions: once, the label suggestions made before item 56 shipped (26 on
//      production on 5 Nov, many the same matter worded differently) are grouped by matter,
//      made into labels (or matched to an existing one) and their conversations filed. A
//      suggestion left unfiled (in no group, a job thread) goes back to null, so the older
//      pass below reads it under the new rules. Remove after 30 Nov 2026.
//   2. fileOldConversations: the last 60 days, a batch at a time, newest first. A conversation
//      (mail both ways, 2 or more emails) with no job and no label goes through the same label
//      pass and rules as new mail. Every thread looked at is marked suggested_label '' (or
//      given a suggestion) so it is read once; new mail on it is handled by the sort.
//
// A new label asks for its sweep (email-agent.js sweepLabels, narrowed to the same senders).
// Writes email_labels, email_thread_labels, email_threads.suggested_label, Gmail labels.

const {
  isConversation, applyLabelPick, fileUnder, makeAgentLabel, chooseLabels, messagesFor, threadText, findLabel,
  inboxWho, labelList, claude, textOf, addUsage, LABEL_MODEL,
} = require('./email-agent');
const { GROUP_PROMPT } = require('../../../agents/prompts/postie-labels.js');

const BATCH = 10;
const DAYS = 60;
const GROUP_BEFORE = '2026-11-06T00:00:00Z'; // suggestions made before item 56 (old rules)
const GROUP_UNTIL = '2026-11-30T00:00:00Z';  // the one-off is off after this date

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

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// threads among ids that are tagged to a job or already under a label
async function taken(admin, ids) {
  const [labelled, jobs] = await Promise.all([
    admin.from('email_thread_labels').select('thread_id').in('thread_id', ids),
    admin.from('email_job_links').select('thread_id').in('thread_id', ids),
  ]);
  if (labelled.error || jobs.error) throw labelled.error || jobs.error; // never file a job thread by mistake
  return new Set([...labelled.data, ...jobs.data].map((r) => r.thread_id));
}

async function groupOldSuggestions(admin, apiKey, mailbox, ctx, usage) {
  if (Date.now() > Date.parse(GROUP_UNTIL)) return 0;
  const { data: threads } = await admin.from('email_threads').select('id, gmail_thread_id, suggested_label')
    .eq('mailbox_id', mailbox.id).not('suggested_label', 'is', null).neq('suggested_label', '').lt('triaged_at', GROUP_BEFORE).limit(200);
  if (!threads || !threads.length) return 0;
  const skip = await taken(admin, threads.map((t) => t.id));
  const open = threads.filter((t) => !skip.has(t.id));
  const names = [...new Set(open.map((t) => t.suggested_label))];
  let groups = [];
  if (names.length) {
    const data = await claude(apiKey, {
      model: LABEL_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: GROUP_SCHEMA } },
      system: GROUP_PROMPT.replace('{{who}}', () => inboxWho(mailbox, ctx)).replace('{{labels}}', () => labelList(ctx.labels)),
      messages: [{ role: 'user', content: `Suggested label names:\n${names.map((n) => `- ${n} (${open.filter((t) => t.suggested_label === n).length})`).join('\n')}` }],
    });
    addUsage(usage, data);
    try { groups = JSON.parse(textOf(data)).groups || []; } catch { return 0; } // cut off: try again next run
  }
  const filed = new Set();
  for (const g of groups) {
    const want = new Set((g.suggestions || []).map(norm));
    const members = open.filter((t) => want.has(norm(t.suggested_label)));
    if (!members.length || !norm(g.name)) continue;
    const label = findLabel(ctx.labels, g.name) || await makeAgentLabel(admin, mailbox, ctx, String(g.name).replace(/—/g, ','), String(g.about || '').replace(/—/g, ','));
    if (!label) continue;
    for (const t of members) if (await fileUnder(admin, mailbox, t, label)) filed.add(t.id);
  }
  // filed: done (''). The rest (in no group, a job thread, a label that could not be made) go
  // back to null for the older pass, so this one-off never reads them again.
  const ids = threads.map((t) => t.id);
  const rest = ids.filter((id) => !filed.has(id));
  for (const [list, value] of [[[...filed], ''], [rest, null]]) {
    if (!list.length) continue;
    const { error } = await admin.from('email_threads').update({ suggested_label: value }).in('id', list);
    if (error) throw error;
  }
  return filed.size;
}

async function fileOldConversations(admin, apiKey, mailbox, ctx, usage, deadline) {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  let filed = 0, read = 0, more = false;
  while (Date.now() < deadline) {
    const { data: threads } = await admin.from('email_threads').select('id, gmail_thread_id, subject, section')
      .eq('mailbox_id', mailbox.id).is('suggested_label', null).eq('is_supplier_bill', false).not('triaged_at', 'is', null)
      .gt('last_message_at', since).order('last_message_at', { ascending: false }).limit(BATCH);
    more = !!(threads && threads.length === BATCH);
    if (!threads || !threads.length) break;
    const ids = threads.map((t) => t.id);
    const [skip, msgs] = await Promise.all([taken(admin, ids), messagesFor(admin, ids)]);
    const items = threads
      .filter((t) => t.section !== 'updates' && !skip.has(t.id) && isConversation(msgs[t.id]))
      .map((t) => ({ id: t.id, text: threadText(t, msgs[t.id]), conversation: true }));
    const picks = items.length ? await chooseLabels(apiKey, { who: inboxWho(mailbox, ctx), labels: ctx.labels, items }, usage) : {};
    const asked = new Set(items.map((i) => i.id));
    let done = 0;
    for (const t of threads) {
      const pick = picks[t.id];
      if (asked.has(t.id) && !pick) continue; // left out of the answer: stays null, read again later
      const suggested = pick ? await applyLabelPick(admin, mailbox, ctx, t, pick) : null;
      if (pick && !suggested && (pick.label || pick.new_label) && pick.sure && pick.verified) filed += 1;
      const { error } = await admin.from('email_threads').update({ suggested_label: suggested || '' }).eq('id', t.id);
      if (error) throw error;
      done += 1;
    }
    read += done;
    // carry on (and ask for another run) only while batches move; a batch the model keeps
    // failing to answer is tried once per normal Postie run, never in a chain
    if (!done) { more = false; break; }
    if (!more) break;
  }
  return { filed, read, more };
}

// One mailbox: the old suggestions first (once), then older conversations until the deadline.
async function fileMatters(admin, apiKey, mailbox, ctx, usage, deadline) {
  if (!mailbox.auto_labels || Date.now() > deadline) return { grouped: 0, filed: 0, read: 0, more: false };
  const grouped = await groupOldSuggestions(admin, apiKey, mailbox, ctx, usage);
  return { grouped, ...(await fileOldConversations(admin, apiKey, mailbox, ctx, usage, deadline)) };
}

module.exports = { fileMatters };
