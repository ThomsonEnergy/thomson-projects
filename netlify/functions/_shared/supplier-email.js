// Emails to suppliers about bills and statements (spec A11c): a query about a bill that does
// not match its PO, a query about statement issues, a request for copies of missing invoices,
// and a request for a statement. draft() writes the email; a person edits it and presses Send,
// then send() sends it through the sales@ Gmail connection FROM invoice@ (sales@ has invoice@ as
// a "Send mail as" address), so the supplier's reply comes back to invoice@ and is linked to the
// bill or statement (query_gmail_thread_id). Nothing is ever sent without a person.

const { gmailRequest } = require('./google-client');
const { sharedMailboxId } = require('./mailboxes');
const { buildMimeMessage } = require('./build-mime-message');
const { INVOICE_ADDRESS } = require('./supplier-bill-intake');

const FROM_NAME = 'Thomson Energy Accounts';
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SIGN_OFF = '\n\nThanks,\nThomson Energy Accounts\ninvoice@thomsonenergy.com.au';

// The supplier's email: their saved contact, else whoever last emailed us a bill or statement.
async function supplierEmail(admin, supplierId) {
  const { data: s } = await admin.from('suppliers').select('name, contact_email').eq('id', supplierId).maybeSingle();
  if (s?.contact_email) return { name: s.name, to: s.contact_email };
  const pick = (raw) => { const m = String(raw || '').match(/<([^>]+)>/); return (m ? m[1] : raw || '').trim(); };
  const { data: b } = await admin.from('supplier_bill_inbox').select('email_from').eq('supplier_id', supplierId).not('email_from', 'is', null).order('created_at', { ascending: false }).limit(1);
  const { data: st } = await admin.from('supplier_statements').select('email_from').eq('supplier_id', supplierId).not('email_from', 'is', null).order('created_at', { ascending: false }).limit(1);
  const raw = b?.[0]?.email_from || st?.[0]?.email_from || '';
  const to = /thomsonenergy\.com\.au/i.test(raw) ? '' : pick(raw);
  return { name: s?.name || 'there', to };
}

async function draft(admin, kind, id) {
  if (kind === 'bill_query') {
    const { data: bill } = await admin.from('supplier_bills').select('*, purchase_orders(po_number)').eq('id', id).single();
    const { name, to } = await supplierEmail(admin, bill.supplier_id);
    const { data: denied } = await admin.from('supplier_bill_line_items').select('description, quantity, unit_cost, resolution_note').eq('bill_id', id).eq('resolution', 'denied');
    const issues = (bill.check_issues || []).filter(i => !['no_po', 'possible_duplicate', 'duplicate_number', 'denied'].includes(i.kind));
    const po = bill.purchase_orders?.po_number;
    const deniedText = (denied || []).length
      ? `We do not accept these charges and will not be paying them as billed:\n\n${denied.map(d => `- ${d.description} (${Number(d.quantity) || 1} x ${money(d.unit_cost)})${d.resolution_note ? ': ' + d.resolution_note : ''}`).join('\n')}\n\n`
      : '';
    const issueText = issues.length ? `${deniedText ? 'Also, these' : 'Some of it'} do${deniedText ? '' : 'es'} not line up with our purchase order${po ? ' ' + po : ''}:\n\n${issues.map(i => '- ' + i.text).join('\n')}\n\n` : (deniedText ? '' : '- (add the details here)\n\n');
    return {
      to,
      subject: `Query on invoice ${bill.bill_number || ''}${po ? ` (our ${po})` : ''}`.trim(),
      body: `Hi ${name},\n\nWe have checked invoice ${bill.bill_number || ''} (${money(bill.amount)}${bill.bill_date ? ', dated ' + bill.bill_date : ''})${po ? ' against our purchase order ' + po : ''}.\n\n${deniedText}${issueText}Could you please explain, or send a credit note / corrected invoice? We will hold the invoice until it is sorted.${SIGN_OFF}`,
    };
  }
  if (kind === 'request_statement') { // id is the supplier
    const { name, to } = await supplierEmail(admin, id);
    return { to, subject: 'Statement request', body: `Hi ${name},\n\nCould you please send us a statement of our account as at the end of last month?${SIGN_OFF}` };
  }
  const { data: st } = await admin.from('supplier_statements').select('*').eq('id', id).single();
  const { name, to } = await supplierEmail(admin, st.supplier_id);
  if (kind === 'request_copies') {
    const missing = (st.issues || []).filter(i => i.kind === 'missing_bill');
    return {
      to,
      subject: `Copies of invoices from your ${st.statement_date || ''} statement`.replace(/\s+/g, ' ').trim(),
      body: `Hi ${name},\n\nYour statement${st.statement_date ? ' dated ' + st.statement_date : ''} lists these invoices that we do not have a copy of:\n\n${missing.map(m => `- ${m.bill_number} (${money(m.amount)}${m.date ? ', ' + m.date : ''})`).join('\n')}\n\nCould you please email copies to ${INVOICE_ADDRESS}?${SIGN_OFF}`,
    };
  }
  // statement_query
  const issues = (st.issues || []).filter(i => ['amount_differs', 'statement_duplicate', 'balance_differs', 'not_on_statement'].includes(i.kind));
  return {
    to,
    subject: `Query on your ${st.statement_date || ''} statement`.replace(/\s+/g, ' ').trim(),
    body: `Hi ${name},\n\nWe have reconciled your statement${st.statement_date ? ' dated ' + st.statement_date : ''} against our records and have a few questions:\n\n${issues.map(i => '- ' + i.text).join('\n') || '- (add the details here)'}\n\nCould you please check these and let us know?${SIGN_OFF}`,
  };
}

async function send(admin, { kind, id, to, subject, body }) {
  if (!to || !/@/.test(to)) throw new Error('Add the supplier\'s email address.');
  const raw = buildMimeMessage({ fromName: FROM_NAME, fromAddress: INVOICE_ADDRESS, to, subject, bodyText: body, bodyHtml: null, attachments: [] });
  const sent = await gmailRequest('messages/send', { method: 'POST', body: { raw } });
  // keep the conversation with the bills, not in the Sales tab
  await admin.from('email_threads').upsert({ mailbox_id: await sharedMailboxId(admin), gmail_thread_id: sent.threadId, subject, is_supplier_bill: true }, { onConflict: 'mailbox_id,gmail_thread_id' });
  const now = new Date().toISOString();
  if (kind === 'bill_query') {
    await admin.from('supplier_bills').update({ check_status: 'queried', query_sent_at: now, query_gmail_thread_id: sent.threadId, approved_for_payment: false }).eq('id', id);
  } else if (kind === 'statement_query' || kind === 'request_copies') {
    await admin.from('supplier_statements').update({ query_sent_at: now, query_gmail_thread_id: sent.threadId }).eq('id', id);
  }
  return { threadId: sent.threadId };
}

module.exports = { draft, send, supplierEmail };
