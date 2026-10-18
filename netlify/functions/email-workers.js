// Scheduled (every minute, see netlify.toml): the email workers on the shared sales@ inbox.
// sync-gmail marks each new incoming email ai_status = 'pending'; this picks them up.
//
//   Postie      sorts each email (spam, customer, builder, supplier, other) with a small model
//   Bouncer     archives spam: out of the TEops Inbox and out of the Gmail inbox, never deleted
//   Tagger      tags the conversation to a job when sure (a J, Q or PO number in the email, or the
//               client's own job), otherwise leaves a suggestion for someone to confirm
//   Ghostwriter drafts a reply (in TEops and in Gmail Drafts) when a customer, builder or
//               supplier asks something. Nothing is ever sent by a worker.
//
// Two passes inside a time budget: sort everything waiting, then draft with what time is left.
// Anything not finished stays queued for the next run. Off switch: Settings > Gmail.

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { gmailRequest, gmailDeleteDraft, GMAIL_MAILBOX } = require('./_shared/google-client');
const { buildMimeMessage } = require('./_shared/build-mime-message');
const { firstAddress } = require('./_shared/gmail-sync');
const { emailText } = require('./extract-email-job');
const { sortPrompt, SORT_SCHEMA, draftPrompt } = require('./_shared/email-worker-prompts');

const SORT_MODEL = 'claude-haiku-5-5';
const DRAFT_MODEL = 'claude-sonnet-5-5';
const BUDGET_MS = 22000;
const DRAFT_NEEDS_MS = 12000; // don't start a draft with less than this left
const MAX_ATTEMPTS = 3;
const MAX_THREAD_TEXT = 12000;
const OWN_DOMAIN = /@thomsonenergy\.com\.au$/i;
const DRAFT_FOR = ['customer', 'builder', 'supplier'];
const LINK_KIND = { customer: 'client', builder: 'client', supplier: 'supplier', other: 'other' };
const PROJECT_FIELDS = 'id, name, client_name, client_email, client_address, client_id, pipeline_stage, job_number, quote_number';

function projectRef(p) {
  if (p.job_number) return `J${p.job_number}`;
  if (p.quote_number) return `Q${p.quote_number}`;
  return p.name || 'job';
}

async function callClaude({ model, prompt, maxTokens, effort, schema }) {
  const apiKey = await getIntegrationKey('anthropic');
  const outputConfig = { effort };
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, output_config: outputConfig, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined this email.');
  if (data.stop_reason === 'max_tokens') throw new Error('The model ran out of room.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// The conversation as text, newest messages kept when it is long.
function threadTranscript(emails) {
  const blocks = emails.map((e) => `--- ${e.direction === 'outbound' ? 'SENT by us' : 'RECEIVED'} | from: ${e.from_address || ''} | ${e.sent_at || ''}\n${emailText(e) || '(no text)'}\n`);
  let out = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (out.length + blocks[i].length > MAX_THREAD_TEXT) { out = blocks[i].slice(-Math.max(0, MAX_THREAD_TEXT - out.length)) + out; break; }
    out = blocks[i] + '\n' + out;
  }
  return out;
}

// Who sent it, as far as TEops knows: a client, a client's contact, a supplier, or nobody.
async function identifySender(db, address) {
  if (!address) return { label: 'unknown to us' };
  const { data: client } = await db.from('clients').select('id, name').ilike('email', address).limit(1).maybeSingle();
  if (client) return { label: `our client ${client.name}`, clientId: client.id };
  const { data: contact } = await db.from('client_contacts').select('client_id, name, clients(name)').ilike('email', address).limit(1).maybeSingle();
  if (contact) return { label: `${contact.name || 'a contact'} at our client ${contact.clients?.name || ''}`.trim(), clientId: contact.client_id };
  const { data: supplier } = await db.from('suppliers').select('id, name').ilike('contact_email', address).limit(1).maybeSingle();
  if (supplier) return { label: `our supplier ${supplier.name}`, supplierId: supplier.id };
  return { label: 'unknown to us (not a saved client or supplier)' };
}

// Jobs this email might belong to. explicit = its J, Q or PO number is in the email itself.
async function findCandidates(db, text, sender, senderAddress) {
  const found = new Map();
  const add = (p, why, explicit) => {
    if (!p || p.pipeline_stage === 'archived') return;
    const had = found.get(p.id);
    if (had) { had.explicit = had.explicit || explicit; return; }
    found.set(p.id, { id: p.id, ref: `${projectRef(p)} - ${p.name}`, client: p.client_name, address: p.client_address, stage: p.pipeline_stage, why, explicit, clientId: p.client_id, clientEmail: p.client_email });
  };

  for (const m of text.matchAll(/\b([JQ])[\s#-]?(\d{3,6})\b/gi)) {
    const col = m[1].toUpperCase() === 'J' ? 'job_number' : 'quote_number';
    const { data } = await db.from('projects').select(PROJECT_FIELDS).eq(col, Number(m[2])).limit(1);
    add((data || [])[0], `${m[1].toUpperCase()}${m[2]} is in the email`, true);
  }
  for (const m of text.matchAll(/\bPO[\s#-]*(\d{2,8})\b/gi)) {
    const variants = [m[1], `PO${m[1]}`, `PO-${m[1]}`];
    const { data: pos } = await db.from('purchase_orders').select(`project_id, projects(${PROJECT_FIELDS})`)
      .or(`po_number.in.(${variants.join(',')}),po_sequence_number.in.(${variants.join(',')})`).not('project_id', 'is', null).limit(2);
    (pos || []).forEach((po) => add(po.projects, `PO ${m[1]} is in the email`, true));
  }

  const byClient = sender.clientId
    ? db.from('projects').select(PROJECT_FIELDS).eq('client_id', sender.clientId)
    : senderAddress ? db.from('projects').select(PROJECT_FIELDS).ilike('client_email', senderAddress) : null;
  if (byClient) {
    const { data } = await byClient.neq('pipeline_stage', 'archived').order('created_at', { ascending: false }).limit(12);
    (data || []).forEach((p) => add(p, "the sender's job", false));
  }
  return [...found.values()].slice(0, 20);
}

async function notifySalesTeam(db, kind, title, body, link, dedupe) {
  const { data: people } = await db.from('profiles').select('id').eq('active', true).in('role', ['admin', 'sales']);
  for (const p of people || []) {
    await db.rpc('create_notification', { p_user: p.id, p_kind: kind, p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe });
  }
}

// Bouncer: out of the Inbox here and in Gmail. Reversible from the Spam tab.
async function bounce(db, thread, email) {
  await db.from('email_threads').update({ spam_at: new Date().toISOString(), is_read: true }).eq('id', thread.id);
  // the "New email" ping for it: drop it if it hasn't gone to phones yet, otherwise mark it read
  await db.from('notifications').delete().eq('dedupe_key', `email:${email.id}`).is('pushed_at', null);
  await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('dedupe_key', `email:${email.id}`).is('read_at', null);
  try {
    await gmailRequest(`threads/${thread.gmail_thread_id}/modify`, { method: 'POST', body: { removeLabelIds: ['INBOX'] } });
  } catch (err) {
    return `Archived in TEops, but not in Gmail: ${err.message}`;
  }
  return null;
}

// Tagger: tag when sure, suggest when guessing. A conversation someone already tagged is left alone.
async function tag(db, thread, sort, candidates, sender) {
  const { data: links } = await db.from('email_job_links').select('id').eq('thread_id', thread.id).limit(1);
  if ((links || []).length) return;

  let pick = sort.job > 0 ? candidates[sort.job - 1] : null;
  const explicit = candidates.filter((c) => c.explicit);
  if (!pick && explicit.length === 1) pick = explicit[0];
  if (!pick) return;

  const fromTheirClient = !!sender.clientId && pick.clientId === sender.clientId;
  const sure = pick.explicit || (sort.job_confidence === 'sure' && fromTheirClient);
  if (sure) {
    await db.from('email_job_links').upsert(
      { thread_id: thread.id, project_id: pick.id, kind: LINK_KIND[sort.category] || 'other', note: `Tagger: ${sort.reason}`.slice(0, 300), tagged_by_ai: true },
      { onConflict: 'thread_id,project_id', ignoreDuplicates: true },
    );
    await db.from('email_threads').update({ ai_suggested_project_id: null, ai_suggested_reason: null }).eq('id', thread.id);
  } else {
    await db.from('email_threads').update({ ai_suggested_project_id: pick.id, ai_suggested_reason: sort.reason.slice(0, 300) }).eq('id', thread.id);
  }
}

// Postie: sort one email, then hand it to Bouncer, Tagger and (later in the run) Ghostwriter.
async function sortOne(db, email) {
  const { data: thread } = await db.from('email_threads').select('*').eq('id', email.thread_id).single();
  const { data: emails } = await db.from('emails').select('id, direction, from_address, sent_at, body_text, body_html').eq('thread_id', thread.id).order('sent_at', { ascending: true });
  const senderAddress = firstAddress(email.from_address);
  const sender = await identifySender(db, senderAddress);
  const ownText = `${email.subject || ''}\n${emailText(email)}`;
  const candidates = await findCandidates(db, ownText, sender, senderAddress);

  const raw = await callClaude({
    model: SORT_MODEL, maxTokens: 4000, effort: 'low', schema: SORT_SCHEMA,
    prompt: sortPrompt({ fromLine: email.from_address || 'unknown', subject: thread.subject, threadText: threadTranscript(emails || []), knownSender: sender.label, candidates }),
  });
  const sort = JSON.parse(raw);
  if (!(sort.job >= 0 && sort.job <= candidates.length)) sort.job = 0;

  // Never bounce someone we deal with, or a conversation we have written in or tagged.
  const { count: linked } = await db.from('email_job_links').select('id', { count: 'exact', head: true }).eq('thread_id', thread.id);
  const weReplied = (emails || []).some((e) => e.direction === 'outbound');
  const known = sender.clientId || sender.supplierId || OWN_DOMAIN.test(senderAddress);
  if (sort.category === 'spam' && (known || weReplied || linked)) sort.category = 'other';

  let note = null;
  if (sort.category === 'spam') note = await bounce(db, thread, email);
  else await tag(db, thread, sort, candidates, sender);

  const wantsDraft = DRAFT_FOR.includes(sort.category) && sort.needs_reply;
  await db.from('emails').update({
    ai_status: wantsDraft ? 'sorted' : 'done', ai_category: sort.category, ai_error: note,
    ai_processed_at: new Date().toISOString(),
  }).eq('id', email.id);
}

async function jobContext(db, threadId, category) {
  const { data: links } = await db.from('email_job_links').select(`projects(${PROJECT_FIELDS}, installer_summary, notes)`).eq('thread_id', threadId);
  const today = new Date().toISOString().slice(0, 10);
  const parts = [];
  for (const { projects: p } of links || []) {
    if (!p) continue;
    const { data: booked } = await db.from('schedule_assignments').select('assignment_date, start_time').eq('project_id', p.id).gte('assignment_date', today).order('assignment_date').limit(3);
    const lines = [`${projectRef(p)} - ${p.name}`, `Client: ${p.client_name || '-'}`, `Site: ${p.client_address || '-'}`, `Stage: ${p.pipeline_stage}`];
    lines.push(`Booked: ${(booked || []).length ? [...new Set(booked.map((b) => b.assignment_date))].join(', ') : 'nothing booked yet'}`);
    if (p.installer_summary) lines.push(`Scope: ${p.installer_summary.slice(0, 1500)}`);
    if (category === 'supplier') {
      const { data: pos } = await db.from('purchase_orders').select('po_number, supplier_name, description, status, received').eq('project_id', p.id).limit(10);
      if ((pos || []).length) lines.push('Our purchase orders: ' + pos.map((po) => `${po.po_number || '(no number)'} ${po.supplier_name}: ${po.description || ''} (${po.received ? 'received' : po.status})`).join('; '));
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// Ghostwriter: one draft per conversation, for its latest incoming email only.
async function draftOne(db, email, companyName) {
  const { data: thread } = await db.from('email_threads').select('*').eq('id', email.thread_id).single();
  const { data: emails } = await db.from('emails').select('id, direction, from_address, to_addresses, sent_at, body_text, body_html, message_id_header').eq('thread_id', thread.id).order('sent_at', { ascending: true });
  const last = (emails || []).slice(-1)[0];
  const done = (error) => db.from('emails').update({ ai_status: 'done', ai_error: error || null }).eq('id', email.id);
  // a newer message (ours or theirs) has come in since: no draft for this one
  if (!last || last.id !== email.id || thread.spam_at) return done();

  const body = await callClaude({
    model: DRAFT_MODEL, maxTokens: 8000, effort: 'medium',
    prompt: draftPrompt({ category: email.ai_category, fromLine: email.from_address || '', subject: thread.subject, threadText: threadTranscript(emails), jobContext: await jobContext(db, thread.id, email.ai_category), companyName }),
  });
  if (!body) throw new Error('Ghostwriter came back empty.');

  const { data: old } = await db.from('email_drafts').select('id, gmail_draft_id').eq('thread_id', thread.id).eq('status', 'ready');
  for (const d of old || []) await gmailDeleteDraft(d.gmail_draft_id);
  if ((old || []).length) await db.from('email_drafts').update({ status: 'dismissed', updated_at: new Date().toISOString() }).in('id', old.map((d) => d.id));

  let gmailDraftId = null, gmailError = null;
  try {
    const subject = thread.subject && !/^re:/i.test(thread.subject) ? `Re: ${thread.subject}` : (thread.subject || '');
    const raw = buildMimeMessage({ fromName: companyName, fromAddress: GMAIL_MAILBOX, to: email.from_address, subject, bodyText: body, inReplyTo: email.message_id_header || undefined, references: email.message_id_header || undefined });
    const draft = await gmailRequest('drafts', { method: 'POST', body: { message: { raw, threadId: thread.gmail_thread_id } } });
    gmailDraftId = draft.id;
  } catch (err) {
    gmailError = `Draft is in TEops, but not in Gmail Drafts: ${err.message}`;
  }

  const { error } = await db.from('email_drafts').insert({ thread_id: thread.id, reply_to_email_id: email.id, body_text: body, gmail_draft_id: gmailDraftId });
  if (error) throw error;
  await done(gmailError);
  await notifySalesTeam(db, 'email_draft', `Draft ready: ${thread.subject || '(no subject)'}`, 'Ghostwriter drafted a reply. Check it and send.', `/inbox.html?thread=${thread.id}`, `email_draft:${email.id}`);
}

async function failed(db, email, err) {
  console.error(`email-workers: email ${email.id} failed:`, err.message);
  const attempts = (email.ai_attempts || 0) + 1;
  await db.from('emails').update({ ai_attempts: attempts, ai_error: err.message.slice(0, 500), ...(attempts >= MAX_ATTEMPTS ? { ai_status: 'error' } : {}) }).eq('id', email.id);
}

exports.handler = async () => {
  const startedAt = Date.now();
  const left = () => BUDGET_MS - (Date.now() - startedAt);
  const db = getAdminClient();
  try {
    const { data: settings } = await db.from('company_settings').select('email_workers_on, company_name').eq('id', 1).maybeSingle();
    if (settings && settings.email_workers_on === false) return { statusCode: 200, body: JSON.stringify({ ok: true, off: true }) };
    const companyName = settings?.company_name || 'Thomson Energy';

    const { data: queue } = await db.from('emails').select('*').in('ai_status', ['pending', 'sorted']).order('created_at', { ascending: true }).limit(25);
    let sorted = 0, drafted = 0;
    for (const email of (queue || []).filter((e) => e.ai_status === 'pending')) {
      if (left() < 4000) break;
      try { await sortOne(db, email); sorted += 1; } catch (err) { await failed(db, email, err); }
    }
    const { data: toDraft } = await db.from('emails').select('*').eq('ai_status', 'sorted').order('created_at', { ascending: true }).limit(5);
    for (const email of toDraft || []) {
      if (left() < DRAFT_NEEDS_MS) break;
      try { await draftOne(db, email, companyName); drafted += 1; } catch (err) { await failed(db, email, err); }
    }
    if (sorted || drafted) console.log(`email-workers: sorted ${sorted}, drafted ${drafted}.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, sorted, drafted }) };
  } catch (err) {
    console.error('email-workers failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

