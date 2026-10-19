// Supplier statements: emailed or uploaded, read and reconciled (spec A11c,
// migration 20261019030000).
//
// Emailed statements come from two places: anything the bill reader read as a statement
// (supplier_bill_inbox, document_type statement), and an hourly look in sales@ (which includes
// invoice@) for "statement" emails with a PDF or photo. Uploaded ones are saved by
// supplier-detail.html with their lines and reconciled here too.
//
// reconcileStatement() checks both ways against our supplier_bills:
//   missing_bill         on the statement, not in TEops (a bill we never got or never entered)
//   amount_differs       in both, different amounts
//   statement_duplicate  the same invoice number listed twice on the statement
//   our_duplicate        a bill entered twice in TEops (same number, or same amount and date)
//   not_on_statement     an unpaid bill of ours in the statement's period that it does not show
//   bill_problems        on the statement, but our bill failed its PO check or is queried
//   no_po                on the statement, our bill has no PO
//   balance_differs      the statement balance vs what we think we owe
// The same run also checks any bill not checked yet against its PO (_shared/bill-check.js).

const { getAdminClient } = require('./require-admin');
const { gmailRequest } = require('./google-client');
const { sharedMailboxId } = require('./mailboxes');
const { selfBaseUrl } = require('./site-url');
const fetch = require('node-fetch');
const { matchSupplier, downloadAttachment } = require('./supplier-bill-intake');
const { extractStatement } = require('./statement-ai');
const { checkBill } = require('./bill-check');

const GMAIL_QUERY = 'has:attachment newer_than:60d -in:sent subject:statement';
const READABLE = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_ATTEMPTS = 3;

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// INV-0103, inv103 and INV 103 are the same number (same rule as _shared/bill-check.js)
const normNum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(inv|invoice)/, '').replace(/^0+/, '');
const headerValue = (headers, name) => (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || null;

async function startStatementProcessing() {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/process-statements-background`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 8000 });
    if (!res.ok && res.status !== 202) console.error('statement processing did not start:', res.status);
  } catch (err) {
    console.error('statement processing did not start:', err.message);
  }
}

// ---------- finding them ----------

async function enqueue(admin, { extractAttachments }) {
  let added = 0;
  const add = async (row) => {
    const { data: exists } = await admin.from('supplier_statements').select('id').eq('gmail_message_id', row.gmail_message_id).eq('attachment_part_id', row.attachment_part_id).maybeSingle();
    if (exists) return;
    const { error } = await admin.from('supplier_statements').insert({ ...row, status: 'pending', total_amount: 0 });
    if (error && !/duplicate/i.test(error.message)) throw error;
    if (!error) added += 1;
  };

  const { data: fromBills } = await admin.from('supplier_bill_inbox')
    .select('email_id, gmail_message_id, attachment_part_id, file_name, mime_type, email_from, supplier_id')
    .in('status', ['to_check', 'not_a_bill']).eq('extracted->>document_type', 'statement').limit(50);
  for (const b of fromBills || []) {
    await add({ email_id: b.email_id, gmail_message_id: b.gmail_message_id, attachment_part_id: b.attachment_part_id, file_name: b.file_name, email_from: b.email_from, supplier_id: b.supplier_id });
    await admin.from('supplier_bill_inbox').update({ status: 'not_a_bill', match_reason: 'Statement: reconciled on the Bill checks page' })
      .eq('gmail_message_id', b.gmail_message_id).eq('attachment_part_id', b.attachment_part_id).eq('status', 'to_check');
  }

  const list = await gmailRequest(`messages?maxResults=30&q=${encodeURIComponent(GMAIL_QUERY)}`);
  for (const m of list.messages || []) {
    const { count } = await admin.from('supplier_statements').select('id', { count: 'exact', head: true }).eq('gmail_message_id', m.id);
    if (count) continue;
    const msg = await gmailRequest(`messages/${m.id}?format=full`);
    const files = extractAttachments(msg.payload).filter(a => !a.inline && (READABLE.includes((a.mime || '').toLowerCase()) || /\.pdf$/i.test(a.name || '')));
    if (!files.length) continue;
    const { data: email } = await admin.from('emails').select('id, email_threads!inner(mailbox_id)').eq('gmail_message_id', m.id).eq('email_threads.mailbox_id', await sharedMailboxId(admin)).maybeSingle();
    for (const f of files) {
      await add({ email_id: email?.id || null, gmail_message_id: m.id, attachment_part_id: String(f.part_id), file_name: f.name, email_from: headerValue(msg.payload?.headers, 'From') });
    }
  }
  return added;
}

// ---------- reconciling ----------

async function reconcileStatement(admin, statementId) {
  const { data: st } = await admin.from('supplier_statements').select('*').eq('id', statementId).single();
  if (!st.supplier_id) {
    await admin.from('supplier_statements').update({ status: 'issues', issues: [{ kind: 'no_supplier', text: `Supplier "${st.supplier_name_read || 'unknown'}" not recognised: pick the supplier.` }] }).eq('id', st.id);
    return { status: 'issues', issues: 1 };
  }
  const { data: billsRaw } = await admin.from('supplier_bills').select('id, bill_number, amount, bill_date, paid, po_id, check_status').eq('supplier_id', st.supplier_id);
  const bills = billsRaw || [];
  const lines = (st.lines || []).filter(l => (l.type || 'invoice') === 'invoice' && l.bill_number);
  const issues = [];

  // the same number twice on the statement
  const seen = {};
  lines.forEach(l => { const k = normNum(l.bill_number); seen[k] = (seen[k] || 0) + 1; });
  Object.entries(seen).filter(([, n]) => n > 1).forEach(([k]) => {
    const l = lines.find(x => normNum(x.bill_number) === k);
    issues.push({ kind: 'statement_duplicate', bill_number: l.bill_number, text: `Invoice ${l.bill_number} is listed ${seen[k]} times on the statement: billed twice?` });
  });

  // our bills by number (two of ours with one number = entered twice)
  const ours = {};
  bills.forEach(b => { const k = normNum(b.bill_number); if (k) (ours[k] = ours[k] || []).push(b); });
  Object.values(ours).filter(list => list.length > 1).forEach(list => {
    issues.push({ kind: 'our_duplicate', bill_id: list[1].id, bill_number: list[0].bill_number, text: `Bill ${list[0].bill_number} is entered in TEops ${list.length} times` });
  });

  const matchedIds = new Set();
  const done = new Set();
  lines.forEach(l => {
    if (done.has(normNum(l.bill_number))) return; // listed twice: reported once above
    done.add(normNum(l.bill_number));
    const list = ours[normNum(l.bill_number)];
    if (!list) { issues.push({ kind: 'missing_bill', bill_number: l.bill_number, amount: l.amount, date: l.date, text: `Invoice ${l.bill_number} (${money(l.amount)}${l.date ? ', ' + l.date : ''}) is on the statement but not in TEops` }); return; }
    const b = list[0];
    matchedIds.add(b.id);
    if (Math.abs((Number(b.amount) || 0) - (Number(l.amount) || 0)) > 0.5) {
      issues.push({ kind: 'amount_differs', bill_id: b.id, bill_number: l.bill_number, text: `Invoice ${l.bill_number}: statement says ${money(l.amount)}, our bill is ${money(b.amount)}` });
    }
    if (['problems', 'queried'].includes(b.check_status)) {
      issues.push({ kind: 'bill_problems', bill_id: b.id, bill_number: l.bill_number, text: `Invoice ${l.bill_number} ${b.check_status === 'queried' ? 'is queried with the supplier' : 'does not match its PO'}` });
    } else if (!b.po_id) {
      issues.push({ kind: 'no_po', bill_id: b.id, bill_number: l.bill_number, text: `Invoice ${l.bill_number} has no PO in TEops` });
    }
  });

  // our unpaid bills in the statement's period that it does not show
  const stDate = st.statement_date || new Date().toISOString().slice(0, 10);
  const dates = lines.map(l => l.date).filter(Boolean).sort();
  const from = dates[0] || new Date(new Date(stDate).getTime() - 62 * 86400000).toISOString().slice(0, 10);
  bills.filter(b => !b.paid && !matchedIds.has(b.id) && b.bill_date && b.bill_date >= from && b.bill_date <= stDate).forEach(b => {
    issues.push({ kind: 'not_on_statement', bill_id: b.id, bill_number: b.bill_number, text: `Our bill ${b.bill_number || '(no number)'} (${money(b.amount)}, ${b.bill_date}) is not on the statement: paid already, or entered against the wrong supplier?` });
  });

  // balance
  const ourUnpaid = bills.filter(b => !b.paid && (!b.bill_date || b.bill_date <= stDate)).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  if (Number(st.total_amount) && Math.abs(ourUnpaid - Number(st.total_amount)) > 1) {
    issues.push({ kind: 'balance_differs', text: `Statement balance ${money(st.total_amount)}, our unpaid bills to ${stDate} come to ${money(ourUnpaid)} (${money(Number(st.total_amount) - ourUnpaid)} difference)` });
  }

  const status = issues.length ? 'issues' : 'reconciled';
  await admin.from('supplier_statements').update({ status: st.status === 'reviewed' ? 'reviewed' : status, issues, our_unpaid: Math.round(ourUnpaid * 100) / 100, processed_at: new Date().toISOString(), error: null }).eq('id', st.id);
  return { status, issues: issues.length };
}

// Suppliers we were billed by last month with no statement since the start of last month.
// Only from the 10th of the month, so statements have had time to arrive.
async function missingStatements(admin) {
  const now = new Date();
  const sydney = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  if (sydney.getDate() < 10) return [];
  const startLast = new Date(sydney.getFullYear(), sydney.getMonth() - 1, 1).toISOString().slice(0, 10);
  const startThis = new Date(sydney.getFullYear(), sydney.getMonth(), 1).toISOString().slice(0, 10);
  const { data: billed } = await admin.from('supplier_bills').select('supplier_id').gte('bill_date', startLast).lt('bill_date', startThis);
  const ids = [...new Set((billed || []).map(b => b.supplier_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: sts } = await admin.from('supplier_statements').select('supplier_id').in('supplier_id', ids).gte('statement_date', startLast);
  const have = new Set((sts || []).map(s => s.supplier_id));
  const { data: sups } = await admin.from('suppliers').select('id, name').in('id', ids.filter(i => !have.has(i)));
  return sups || [];
}

// ---------- the run ----------

async function notifyCheckers(admin, title, body) {
  const { data: people } = await admin.from('profiles').select('id').eq('active', true).in('role', ['admin', 'finance']);
  for (const p of people || []) {
    await admin.rpc('create_notification', { p_user: p.id, p_kind: 'statement', p_title: title, p_body: String(body).slice(0, 300), p_link: '/supplier-checks.html', p_actor: null, p_dedupe: `statement:${title}:${new Date().toISOString().slice(0, 13)}` });
  }
}

async function processStatements({ budgetMs = 12 * 60 * 1000, extractAttachments } = {}) {
  const started = Date.now();
  const admin = getAdminClient();
  const usage = { input_tokens: 0, output_tokens: 0 };

  // bills never checked against their PO (new ones, and the ones from before this existed)
  const { data: unchecked } = await admin.from('supplier_bills').select('id').is('checked_at', null).limit(200);
  for (const b of unchecked || []) await checkBill(admin, b.id);

  await admin.from('supplier_statements').update({ status: 'pending' }).eq('status', 'processing').lt('processed_at', new Date(Date.now() - 20 * 60000).toISOString());
  const queued = await enqueue(admin, { extractAttachments });
  const { data: suppliers } = await admin.from('suppliers').select('*');
  const { data: pending } = await admin.from('supplier_statements').select('*').eq('status', 'pending').order('created_at').limit(15);

  const results = [];
  for (const row of pending || []) {
    if (Date.now() - started > budgetMs) break;
    const { data: claimed } = await admin.from('supplier_statements').update({ status: 'processing', attempts: row.attempts + 1, processed_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending').select('*').maybeSingle();
    if (!claimed) continue;
    try {
      if (!claimed.file_path || !(claimed.lines || []).length) {
        const buffer = await downloadAttachment(claimed.gmail_message_id, claimed.attachment_part_id);
        const mediaType = /\.pdf$/i.test(claimed.file_name || '') ? 'application/pdf' : 'image/jpeg';
        const path = `statements/emailed/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${String(claimed.file_name || 'statement').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const { error: upErr } = await admin.storage.from('project-documents').upload(path, buffer, { contentType: mediaType });
        if (upErr) throw upErr;
        const read = await extractStatement({ fileBase64: buffer.toString('base64'), mediaType });
        usage.input_tokens += read.usage.input_tokens || 0;
        usage.output_tokens += read.usage.output_tokens || 0;
        const ex = read.extracted;
        if (ex.is_statement === false) {
          await admin.from('supplier_statements').update({ status: 'not_a_statement', file_path: path }).eq('id', row.id);
          results.push('not'); continue;
        }
        const match = claimed.supplier_id ? null : matchSupplier(suppliers, { supplier: ex.supplier, abn: ex.abn, our_account_number: ex.our_account_number });
        await admin.from('supplier_statements').update({
          file_path: path, lines: ex.invoices || [], statement_date: ex.statement_date || null, total_amount: Number(ex.total_amount) || 0,
          supplier_name_read: ex.supplier || null, supplier_id: claimed.supplier_id || match?.supplier?.id || null,
        }).eq('id', row.id);
      }
      const r = await reconcileStatement(admin, row.id);
      const { data: done } = await admin.from('supplier_statements').select('supplier_id, statement_date').eq('id', row.id).single();
      const name = (suppliers || []).find(s => s.id === done.supplier_id)?.name || 'A supplier';
      results.push(`${name} statement${done.statement_date ? ' ' + done.statement_date : ''}: ${r.issues ? `${r.issues} issue${r.issues === 1 ? '' : 's'}` : 'reconciled'}`);
      if (r.issues) await notifyCheckers(admin, `${name} statement has ${r.issues} issue${r.issues === 1 ? '' : 's'}`, 'Open Bill checks to see what does not line up.');
    } catch (err) {
      console.error('statement', row.id, 'failed:', err.message);
      await admin.from('supplier_statements').update({ status: claimed.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', error: err.message.slice(0, 500) }).eq('id', row.id);
      results.push('error');
    }
  }
  return { queued, checked: (unchecked || []).length, results, usage };
}

module.exports = { processStatements, reconcileStatement, missingStatements, startStatementProcessing, normNum };
