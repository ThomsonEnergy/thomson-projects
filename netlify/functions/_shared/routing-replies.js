// Auto replies that point a sender to the right mailbox (migration 20261103010000):
//   Postie (the email agent, sales@): a supplier emailed an invoice to sales@. The invoice is
//     passed into the invoice@ bill intake, and the reply asks them to use invoice@ next time
//     with our PO number on it.
//   Tally (the bill reader, invoice@): an email to invoice@ with no invoice, statement, credit
//     note or price list. The reply asks them to use sales@.
// company_settings.routing_reply_mode: off, draft (a Gmail draft in sales@ for a person to send)
// or send. One reply per conversation (routing_replies.gmail_thread_id) and one per sender every
// 14 days. Never to our own addresses, no-reply senders, automatic mail, or a supplier
// answering one of our bill or statement queries.

const { gmailRequest } = require('./google-client');
const { buildMimeMessage } = require('./build-mime-message');
const { signatureForAgent, plainTextToHtml, SIGNATURE_EMAIL } = require('./build-email-signature');

const INVOICE_ADDRESS = 'invoice@thomsonenergy.com.au';
const SENDER_GAP_DAYS = 14;
const NO_REPLY = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?@)/i;
const OURS = /@thomsonenergy\.com\.au$/i;

const AGENTS = {
  sales_invoice: { name: 'Postie', jobTitle: 'Office assistant', from: SIGNATURE_EMAIL, fromName: 'Postie at Thomson Energy' },
  invoice_not_bill: { name: 'Tally', jobTitle: 'Accounts assistant', from: INVOICE_ADDRESS, fromName: 'Tally at Thomson Energy Accounts' },
};

const headerValue = (headers, name) => (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;
const addrOf = (raw) => { const m = String(raw || '').match(/<([^>]+)>/); return (m ? m[1] : String(raw || '')).trim().toLowerCase(); };

// "'Tradezone' via Thomson Invoices" <invoice@...> -> Tradezone
function greetingName(fromHeader) {
  const m = String(fromHeader || '').match(/^\s*"?([^"<]*?)"?\s*</);
  const name = (m ? m[1] : '').replace(/\s+via\s+.*$/i, '').replace(/^'+|'+$/g, '').trim();
  return name && !/@/.test(name) ? name : '';
}

// The real sender. invoice@ is a Google Group, which can rewrite From to the group's own
// address, so X-Original-Sender and Reply-To are tried first.
function realSender(headers) {
  for (const h of ['X-Original-Sender', 'Reply-To', 'From']) {
    const addr = addrOf(headerValue(headers, h));
    if (addr && /@/.test(addr) && !OURS.test(addr)) return addr;
  }
  return null;
}

function isAutomatic(headers) {
  const auto = (headerValue(headers, 'Auto-Submitted') || '').toLowerCase();
  const precedence = (headerValue(headers, 'Precedence') || '').toLowerCase();
  return (auto && auto !== 'no') || ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)
    || !!headerValue(headers, 'X-Autoreply') || !!headerValue(headers, 'List-Unsubscribe');
}

function bodyFor(kind, name) {
  const hi = `Hi ${name || 'there'},`;
  if (kind === 'sales_invoice') {
    return `${hi}\n\nThanks for your invoice. We have forwarded it to our accounts team this time, but please send all future invoices to ${INVOICE_ADDRESS} and update your contact details for us so they go straight there.\n\nPlease also make sure our PO number is on every invoice so we can match it and pay you quickly.`;
  }
  return `${hi}\n\nThanks for your email. ${INVOICE_ADDRESS} is for supplier invoices, statements, credit notes and price lists only, so anything else sent here may be missed.\n\nPlease send all other emails to ${SIGNATURE_EMAIL} and we will get back to you.`;
}

async function replyMode(admin) {
  const { data } = await admin.from('company_settings').select('routing_reply_mode').eq('id', 1).maybeSingle();
  return data?.routing_reply_mode || 'draft';
}

// Drafts or sends one reply to a Gmail message in the sales@ connection (format=metadata or
// full). Returns { to, mode } when it replied, else null.
async function routingReply(admin, kind, message, { mode } = {}) {
  mode = mode || await replyMode(admin);
  if (mode === 'off') return null;
  const headers = message.payload?.headers || [];
  const sender = realSender(headers);
  if (!sender || NO_REPLY.test(sender) || isAutomatic(headers)) return null;

  const [{ count: queriedBills }, { count: queriedStatements }] = await Promise.all([
    admin.from('supplier_bills').select('id', { count: 'exact', head: true }).eq('query_gmail_thread_id', message.threadId),
    admin.from('supplier_statements').select('id', { count: 'exact', head: true }).eq('query_gmail_thread_id', message.threadId),
  ]);
  if (queriedBills || queriedStatements) return null;
  const since = new Date(Date.now() - SENDER_GAP_DAYS * 86400000).toISOString();
  const { count: recent } = await admin.from('routing_replies').select('id', { count: 'exact', head: true }).eq('sender', sender).gte('created_at', since);
  if (recent) return null;

  // claim the conversation first, so two runs never reply twice
  const subjectIn = headerValue(headers, 'Subject') || '';
  const { data: claim, error } = await admin.from('routing_replies').insert({
    gmail_thread_id: message.threadId, source_message_id: message.id, kind, sender, subject: subjectIn.slice(0, 300), mode,
  }).select('id').single();
  if (error) return null; // already replied in this conversation

  try {
    const agent = AGENTS[kind];
    const sig = await signatureForAgent(admin, { name: agent.name, jobTitle: agent.jobTitle, email: agent.from });
    const text = bodyFor(kind, greetingName(headerValue(headers, 'From')));
    const messageId = headerValue(headers, 'Message-ID');
    const references = [headerValue(headers, 'References'), messageId].filter(Boolean).join(' ');
    const raw = buildMimeMessage({
      fromName: agent.fromName, fromAddress: agent.from, to: sender,
      subject: /^re:/i.test(subjectIn) ? subjectIn : `Re: ${subjectIn}`.trim(),
      bodyText: `${text}\n\n${sig.text}`, bodyHtml: plainTextToHtml(text) + sig.html,
      inReplyTo: messageId || undefined, references: references || undefined, attachments: [],
    });
    if (mode === 'send') {
      const sent = await gmailRequest('messages/send', { method: 'POST', body: { raw, threadId: message.threadId } });
      await admin.from('routing_replies').update({ gmail_message_id: sent.id }).eq('id', claim.id);
    } else {
      const draft = await gmailRequest('drafts', { method: 'POST', body: { message: { raw, threadId: message.threadId } } });
      await admin.from('routing_replies').update({ gmail_draft_id: draft.id }).eq('id', claim.id);
    }
    return { to: sender, mode };
  } catch (err) {
    await admin.from('routing_replies').delete().eq('id', claim.id); // try again next run
    throw err;
  }
}

// Tally: after the bill reader has read the files, replies to invoice@ emails from the last
// 2 days that had nothing to read as a bill. Run at the end of each bill reader run.
async function replyToNonBills(admin) {
  const mode = await replyMode(admin);
  if (mode === 'off') return 0;
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: rows } = await admin.from('supplier_bill_inbox')
    .select('gmail_message_id, attachment_part_id, status, extracted, match_reason').gte('created_at', since);
  const byMessage = {};
  for (const r of rows || []) (byMessage[r.gmail_message_id] = byMessage[r.gmail_message_id] || []).push(r);
  const notBill = (r) => r.attachment_part_id === 'none'
    || (['to_check', 'not_a_bill'].includes(r.status) && r.extracted?.document_type === 'other' && !/price list/i.test(r.match_reason || ''));
  const ids = Object.keys(byMessage).filter((id) => byMessage[id].every(notBill));
  if (!ids.length) return 0;
  const { data: done } = await admin.from('routing_replies').select('source_message_id').in('source_message_id', ids);
  const doneIds = new Set((done || []).map((d) => d.source_message_id));

  let replied = 0;
  for (const id of ids.filter((i) => !doneIds.has(i))) {
    const msg = await gmailRequest(`messages/${id}?format=metadata`);
    const headers = msg.payload?.headers || [];
    // only mail sent to invoice@ (Postie passes sales@ invoices into the same inbox)
    if (![headerValue(headers, 'To'), headerValue(headers, 'Cc')].join(',').toLowerCase().includes(INVOICE_ADDRESS)) continue;
    if (await routingReply(admin, 'invoice_not_bill', msg, { mode })) replied += 1;
  }
  return replied;
}

module.exports = { routingReply, replyToNonBills, replyMode, INVOICE_ADDRESS };
