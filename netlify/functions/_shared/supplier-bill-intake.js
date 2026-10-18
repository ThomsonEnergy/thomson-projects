// invoice@ supplier bill intake (backlog item 8).
//
// Suppliers email bills to invoice@thomsonenergy.com.au, a Google Group that delivers to
// sales@. A Gmail filter on sales@ skips the inbox and labels them "Supplier Bills".
// This module:
//   1. finds those emails (label or invoice@ in the headers) and puts one
//      supplier_bill_inbox row per PDF or photo;
//   2. reads each file with Claude (same reader as a manual upload), matches the supplier
//      (account number > ABN > bank > name, same order as the browser), spots duplicates
//      and works out which PO it belongs to;
//   3. leaves it on the Emailed bills page to be checked, or, when auto-save is on
//      (api_keys supplier_bill_auto_save = 'on') and the match is confident, saves the
//      bill against the PO itself.
// It never approves a bill for payment, never touches Xero, stock or material prices.

const fetch = require('node-fetch');
const { getAdminClient } = require('./require-admin');
const { gmailRequest } = require('./google-client');
const { selfBaseUrl } = require('./site-url');
const { extractSupplierInvoiceWithUsage } = require('./supplier-invoice-ai');

const INVOICE_ADDRESS = 'invoice@thomsonenergy.com.au';
const BILL_LABEL = 'Supplier Bills';
const GMAIL_QUERY = `(label:supplier-bills OR to:${INVOICE_ADDRESS} OR deliveredto:${INVOICE_ADDRESS}) newer_than:30d`;
const READABLE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_ATTEMPTS = 3;
const OPEN_PO = (po) => !['paid', 'invoiced'].includes(po.status);

// ---------- Gmail side ----------

function headerValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

let billLabelIdCache;
async function getBillLabelId() {
  if (billLabelIdCache !== undefined) return billLabelIdCache;
  try {
    const { labels } = await gmailRequest('labels');
    billLabelIdCache = (labels || []).find(l => l.name === BILL_LABEL)?.id || null;
  } catch (err) {
    console.error('could not read Gmail labels:', err.message);
    billLabelIdCache = null;
  }
  return billLabelIdCache;
}

// True when a Gmail message came in through invoice@ (the group keeps invoice@ in To/Cc
// and adds its own list headers) or carries the Supplier Bills label.
function isSupplierBillMessage(msg, billLabelId) {
  if (billLabelId && (msg.labelIds || []).includes(billLabelId)) return true;
  const headers = msg.payload?.headers;
  return ['To', 'Cc', 'Delivered-To', 'X-Original-To', 'List-ID', 'List-Post', 'Mailing-list']
    .some(name => {
      const v = (headerValue(headers, name) || '').toLowerCase();
      return v.includes(INVOICE_ADDRESS) || v.includes('invoice.thomsonenergy.com.au');
    });
}

// The parts of an email worth reading as a bill: PDFs and photos sent as attachments.
// Small inline images are logos and signatures, not bills.
function billFiles(attachments) {
  return (attachments || []).filter(a => {
    const mime = (a.mime || '').toLowerCase();
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(a.name || '');
    if (isPdf) return true;
    return mime.startsWith('image/') && !a.inline && (a.size || 0) >= 20000;
  });
}

function findPart(payload, partId) {
  if (!payload) return null;
  if ((payload.partId || null) === partId && (payload.body?.attachmentId || payload.body?.data)) return payload;
  for (const p of payload.parts || []) {
    const hit = findPart(p, partId);
    if (hit) return hit;
  }
  return null;
}

async function downloadAttachment(gmailMessageId, partId) {
  const msg = await gmailRequest(`messages/${gmailMessageId}?format=full`);
  const part = findPart(msg.payload, String(partId));
  if (!part) throw new Error('That attachment is no longer in Gmail.');
  let b64url = part.body.data;
  if (!b64url) b64url = (await gmailRequest(`messages/${gmailMessageId}/attachments/${part.body.attachmentId}`)).data;
  if (!b64url) throw new Error('Gmail returned an empty file.');
  return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Starts process-supplier-bills-background.js. Awaited only until it is accepted (a function
// can be frozen the moment it returns). Never throws: the mail sync must carry on regardless.
async function startSupplierBillProcessing() {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/process-supplier-bills-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 8000,
    });
    if (!res.ok && res.status !== 202) console.error('supplier bill processing did not start:', res.status);
  } catch (err) {
    console.error('supplier bill processing did not start:', err.message);
  }
}

// Finds invoice@ emails from the last 30 days that have no inbox rows yet, flags their
// conversation as a bill (hidden from the Sales tab) and adds one row per file.
async function enqueueNewBillEmails(supabaseAdmin, { extractAttachments, extractPlainText }) {
  const list = await gmailRequest(`messages?maxResults=50&q=${encodeURIComponent(GMAIL_QUERY)}`);
  const ids = (list.messages || []).map(m => m.id);
  if (!ids.length) return 0;
  const { data: known } = await supabaseAdmin.from('supplier_bill_inbox').select('gmail_message_id').in('gmail_message_id', ids);
  const knownIds = new Set((known || []).map(r => r.gmail_message_id));
  let added = 0;
  for (const id of ids.filter(i => !knownIds.has(i))) {
    const msg = await gmailRequest(`messages/${id}?format=full`);
    const headers = msg.payload?.headers;
    const { data: email } = await supabaseAdmin.from('emails').select('id, thread_id').eq('gmail_message_id', id).maybeSingle();
    if (email) await supabaseAdmin.from('email_threads').update({ is_supplier_bill: true }).eq('id', email.thread_id);
    else await supabaseAdmin.from('email_threads').update({ is_supplier_bill: true }).eq('gmail_thread_id', msg.threadId);

    const dateHeader = headerValue(headers, 'Date');
    const base = {
      email_id: email?.id || null,
      gmail_message_id: id,
      email_from: headerValue(headers, 'From'),
      email_subject: headerValue(headers, 'Subject'),
      received_at: dateHeader ? new Date(dateHeader).toISOString() : new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    };
    const files = billFiles(extractAttachments(msg.payload));
    const rows = files.length
      ? files.map(f => ({ ...base, attachment_part_id: String(f.part_id), file_name: f.name, mime_type: f.mime }))
      : [{ ...base, attachment_part_id: 'none', status: 'to_check', match_confidence: 'none', processed_at: new Date().toISOString(),
          match_reason: 'No PDF or photo attached. Open the email in Gmail (Supplier Bills label) and upload the bill by hand.',
          extracted: { email_text: (extractPlainText(msg.payload) || '').slice(0, 2000) } }];
    const { error } = await supabaseAdmin.from('supplier_bill_inbox').upsert(rows, { onConflict: 'gmail_message_id,attachment_part_id', ignoreDuplicates: true });
    if (error) throw error;
    added += rows.length;
    if (!files.length) await notifyToCheck(supabaseAdmin, rows[0], 'An emailed bill has no PDF attached');
  }
  return added;
}

// ---------- matching ----------

// Same scoring as fuzzyMatchScore() in supabase-client.js.
function fuzzyMatchScore(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const wordsA = new Set(norm(a));
  const wordsB = norm(b);
  if (!wordsA.size || !wordsB.length) return 0;
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  return matches / Math.max(wordsA.size, wordsB.length);
}

// Same order as findMatchingSupplier() in supabase-client.js. Returns { supplier, how } or null.
function matchSupplier(suppliers, ex) {
  const list = suppliers || [];
  if (ex.our_account_number) {
    const s = list.find(x => x.our_account_number && x.our_account_number.trim() === String(ex.our_account_number).trim());
    if (s) return { supplier: s, how: `account number ${ex.our_account_number}` };
  }
  if (ex.abn) {
    const abn = String(ex.abn).replace(/\s/g, '');
    const s = list.find(x => x.abn && x.abn.replace(/\s/g, '') === abn);
    if (s) return { supplier: s, how: 'ABN' };
  }
  if (ex.bsb && ex.bank_account_number) {
    const s = list.find(x => x.bsb === ex.bsb && x.bank_account_number === ex.bank_account_number);
    if (s) return { supplier: s, how: 'bank details' };
  }
  let best = null, bestScore = 0;
  list.forEach(s => {
    const score = fuzzyMatchScore(s.name, ex.supplier);
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return bestScore >= 0.5 ? { supplier: best, how: 'name' } : null;
}

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function poLabel(po) {
  const p = po.projects;
  const job = p ? (p.job_number ? `J${p.job_number} - ${p.name}` : (p.quote_number ? `Q${p.quote_number} - ${p.name}` : p.name)) : 'Stock';
  return `${po.po_number || 'PO'} - ${job}${po.description ? ' - ' + po.description : ''}`;
}

// PO numbers mentioned in a piece of text. In the bill's own order reference field a bare
// number counts; in the email subject or body it needs the PO prefix in front of it.
function poNumbersIn(text, prefix, { bareNumbersCount }) {
  const out = new Set();
  if (!text) return out;
  const re = new RegExp(`\\b${prefix.replace(/[^A-Za-z]/g, '')}\\s*[#:\\-]?\\s*(\\d{3,7})\\b`, 'gi');
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  if (bareNumbersCount) {
    // a bare number, but not one that is clearly a job or quote number (J2014, Job 2014, Q 880)
    const bare = /\d{3,7}/g;
    while ((m = bare.exec(text))) {
      const before = String(text).slice(Math.max(0, m.index - 8), m.index);
      if (/[A-Za-z]$/.test(before) && !new RegExp(`${prefix.replace(/[^A-Za-z]/g, '')}$`, 'i').test(before)) continue;
      if (/\b(job|j|quote|q)\s*[#:\-]?\s*$/i.test(before)) continue;
      out.add(m[0]);
    }
  }
  return out;
}

const digitsOf = (poNumber) => String(poNumber || '').replace(/\D/g, '').replace(/^0+/, '');

// Works out which PO a bill belongs to. Returns { po_id, confidence, reason, candidates }.
// confident: our PO number is on the bill (or in the email) and that PO is for this supplier.
// guess: anything weaker (PO for another supplier, total matches, lines match, only open PO).
function matchPurchaseOrder({ pos, supplierId, ex, subject, bodyText, prefix }) {
  const open = (pos || []).filter(OPEN_PO);
  const candidates = [];
  const add = (po, reason, strength) => {
    if (!po || candidates.some(c => c.po_id === po.id)) return;
    candidates.push({ po_id: po.id, po_number: po.po_number, label: poLabel(po), amount: Number(po.amount) || 0, supplier_id: po.supplier_id, reason, strength });
  };
  const byDigits = (set) => open.filter(po => po.po_number && set.has(digitsOf(po.po_number)));
  const strip = (set) => new Set([...set].map(d => d.replace(/^0+/, '')));

  const onBill = strip(poNumbersIn(ex.our_order_reference, prefix, { bareNumbersCount: true }));
  const inEmail = strip(new Set([...poNumbersIn(subject, prefix, { bareNumbersCount: false }), ...poNumbersIn((bodyText || '').slice(0, 5000), prefix, { bareNumbersCount: false })]));

  byDigits(onBill).forEach(po => {
    if (supplierId && po.supplier_id === supplierId) add(po, `${po.po_number} is on the bill`, 3);
    else add(po, `${po.po_number} is on the bill, but that PO is for ${po.supplier_name || 'another supplier'}`, 2);
  });
  byDigits(inEmail).forEach(po => {
    if (supplierId && po.supplier_id === supplierId) add(po, `${po.po_number} is in the email`, 3);
    else add(po, `${po.po_number} is in the email, but that PO is for ${po.supplier_name || 'another supplier'}`, 2);
  });

  const mine = supplierId ? open.filter(po => po.supplier_id === supplierId) : [];
  const totals = [Number(ex.subtotal), Number(ex.total)].filter(n => n > 0);
  mine.filter(po => totals.some(t => Math.abs((Number(po.amount) || 0) - t) <= 1))
    .forEach(po => add(po, `Same supplier and the total matches (${money(po.amount)})`, 1));

  const billLines = (ex.line_items || []).map(l => l.description).filter(Boolean);
  if (billLines.length) {
    mine.map(po => {
      const poLines = (po.purchase_order_line_items || []).map(l => l.description).filter(Boolean);
      if (!poLines.length) return { po, score: 0 };
      const score = billLines.reduce((sum, d) => sum + Math.max(...poLines.map(p => fuzzyMatchScore(p, d))), 0) / billLines.length;
      return { po, score };
    }).filter(x => x.score >= 0.4).sort((a, b) => b.score - a.score)
      .forEach(x => add(x.po, `Same supplier and ${Math.round(x.score * 100)}% of the lines match`, 1));
  }

  if (mine.length === 1) add(mine[0], 'The only open PO for this supplier', 0);
  mine.slice().sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || ''))).forEach(po => add(po, 'Open PO for this supplier', 0));

  candidates.sort((a, b) => b.strength - a.strength);
  const top = candidates.slice(0, 3);
  // Two different POs both named on the bill/email for this supplier: not confident.
  const strongOnes = top.filter(c => c.strength === 3);
  const confidence = strongOnes.length === 1 ? 'confident' : (top.length ? 'guess' : 'none');
  const best = strongOnes.length === 1 ? strongOnes[0] : top[0];
  let reason = best ? best.reason : (supplierId ? 'No open PO found for this supplier' : 'Supplier not recognised and no PO number found');
  if (strongOnes.length > 1) reason = 'More than one of our PO numbers is on this bill';
  return { po_id: best?.po_id || null, confidence, reason, candidates: top.map(({ strength, ...c }) => c) };
}

async function loadOpenPurchaseOrders(supabaseAdmin) {
  const { data, error } = await supabaseAdmin.from('purchase_orders')
    .select('id, po_number, description, amount, status, supplier_id, supplier_name, order_date, project_id, projects(name, job_number, quote_number), purchase_order_line_items(id, material_id, description, quantity, unit_cost)')
    .not('status', 'in', '(paid,invoiced)');
  if (error) throw error;
  return data || [];
}

async function poPrefix(supabaseAdmin) {
  const { data } = await supabaseAdmin.from('company_settings').select('po_number_prefix').eq('id', 1).maybeSingle();
  return data?.po_number_prefix || 'PO';
}

async function findDuplicateBill(supabaseAdmin, supplierId, billNumber) {
  if (!supplierId || !billNumber) return null;
  const { data } = await supabaseAdmin.from('supplier_bills').select('id').eq('supplier_id', supplierId).ilike('bill_number', String(billNumber).trim()).limit(1);
  return data?.[0]?.id || null;
}

// Supplier, duplicate and PO matching for one inbox row that has been read. Returns the
// fields to write back onto the row. Also used when someone picks the supplier by hand.
async function analyse(supabaseAdmin, row, { supplierId = null } = {}) {
  const ex = row.extracted || {};
  let supplierMatch = null;
  if (supplierId) {
    const { data: s } = await supabaseAdmin.from('suppliers').select('*').eq('id', supplierId).maybeSingle();
    if (s) supplierMatch = { supplier: s, how: 'picked by hand' };
  } else {
    const { data: suppliers } = await supabaseAdmin.from('suppliers').select('*');
    supplierMatch = matchSupplier(suppliers, ex);
  }
  const sid = supplierMatch?.supplier.id || null;

  let bodyText = '';
  if (row.email_id) {
    const { data: email } = await supabaseAdmin.from('emails').select('body_text').eq('id', row.email_id).maybeSingle();
    bodyText = email?.body_text || '';
  }
  const [pos, prefix] = await Promise.all([loadOpenPurchaseOrders(supabaseAdmin), poPrefix(supabaseAdmin)]);
  const po = matchPurchaseOrder({ pos, supplierId: sid, ex, subject: row.email_subject, bodyText, prefix });

  const dupId = await findDuplicateBill(supabaseAdmin, sid, ex.bill_number);
  // the same bill emailed twice before either was saved
  let waitingTwin = null;
  if (!dupId && sid && ex.bill_number) {
    const { data: twins } = await supabaseAdmin.from('supplier_bill_inbox').select('id')
      .eq('supplier_id', sid).eq('status', 'to_check').neq('id', row.id).eq('extracted->>bill_number', String(ex.bill_number)).limit(1);
    waitingTwin = twins?.[0] || null;
  }
  const docType = ex.document_type || 'invoice';
  let status = 'to_check', reason = po.reason, confidence = po.confidence;
  if (dupId) {
    status = 'duplicate';
    reason = `Bill ${ex.bill_number} from ${supplierMatch.supplier.name} is already saved`;
  } else if (waitingTwin) {
    status = 'duplicate';
    reason = `Bill ${ex.bill_number} from ${supplierMatch.supplier.name} was emailed twice; the other copy is waiting to be checked`;
  } else if (docType === 'other' && /price|pricing|catalog/i.test(`${row.file_name || ''} ${row.email_subject || ''}`)) {
    // the price list reader (_shared/price-list-intake.js) picks these up
    status = 'not_a_bill';
    reason = 'Looks like a price list: read on the Price lists page';
  } else if (docType !== 'invoice') {
    confidence = 'guess';
    const looksLike = { credit_note: 'a credit note', statement: 'a statement' }[docType] || 'something other than a bill (price list, quote, remittance or similar)';
    reason = `This looks like ${looksLike}, not a bill. ${po.reason}`;
  } else if (!sid) {
    confidence = po.confidence === 'none' ? 'none' : 'guess';
    reason = `Supplier "${ex.supplier || 'unknown'}" not recognised. ${po.reason}`;
  }
  if (sid && supplierMatch.how !== 'picked by hand' && status === 'to_check') reason += ` (supplier matched by ${supplierMatch.how})`;

  return {
    status,
    supplier_id: sid,
    po_id: dupId ? null : po.po_id,
    match_confidence: confidence,
    match_reason: reason,
    po_candidates: po.candidates,
    duplicate_of_bill_id: dupId,
  };
}

// ---------- saving ----------

// Saves an inbox row as a supplier bill against a PO (or no PO). Lines are linked to the
// PO's lines where the description matches, and flagged the same way the manual review
// screen flags them. Stock levels and material prices are left alone.
async function saveInboxItemAsBill(supabaseAdmin, itemId, { poId = null, userId = null } = {}) {
  const { data: item, error: itemErr } = await supabaseAdmin.from('supplier_bill_inbox').select('*').eq('id', itemId).maybeSingle();
  if (itemErr) throw itemErr;
  if (!item) throw new Error('That emailed bill was not found.');
  if (item.status === 'saved') throw new Error('That bill is already saved.');
  if (!item.supplier_id) throw new Error('Pick the supplier first.');
  const ex = item.extracted || {};

  const { data: supplier } = await supabaseAdmin.from('suppliers').select('*').eq('id', item.supplier_id).single();
  const dupId = await findDuplicateBill(supabaseAdmin, supplier.id, ex.bill_number);
  if (dupId) {
    await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'duplicate', duplicate_of_bill_id: dupId, match_reason: `Bill ${ex.bill_number} is already saved` }).eq('id', itemId);
    throw new Error(`Bill ${ex.bill_number} from ${supplier.name} is already saved.`);
  }

  let po = null;
  if (poId) {
    const { data } = await supabaseAdmin.from('purchase_orders')
      .select('id, po_number, purchase_order_line_items(id, material_id, description, unit_cost)').eq('id', poId).maybeSingle();
    if (!data) throw new Error('That PO no longer exists.');
    po = data;
  }

  let dueDate = null;
  if (ex.bill_date) {
    const { data: computed } = await supabaseAdmin.rpc('calculate_bill_due_date', {
      p_bill_date: ex.bill_date, p_credit_terms_type: supplier.credit_terms_type, p_credit_terms_days: supplier.credit_terms_days,
    });
    dueDate = computed || null;
  }

  const { data: bill, error: billErr } = await supabaseAdmin.from('supplier_bills').insert({
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    bill_number: ex.bill_number || null,
    bill_date: ex.bill_date || null,
    due_date: dueDate,
    amount: Number(ex.total) || 0,
    po_id: po?.id || null,
    po_reference: ex.our_order_reference || null,
    file_path: item.file_path,
    file_name: item.file_name,
    notes: `Emailed to invoice@${item.email_from ? ' by ' + item.email_from : ''}`,
    created_by: userId,
  }).select('id').single();
  if (billErr) throw billErr;

  const poLines = po?.purchase_order_line_items || [];
  const lines = (ex.line_items || []).filter(l => l.description).map(l => {
    const unitCost = Number(l.unit_cost) || 0;
    let best = null, bestScore = 0;
    poLines.forEach(pl => {
      const score = fuzzyMatchScore(pl.description, l.description);
      if (score > bestScore) { bestScore = score; best = pl; }
    });
    const poLine = bestScore >= 0.5 ? best : null;
    let flag = null;
    if (po && !poLine) flag = 'Not on the linked PO';
    else if (poLine && unitCost > Number(poLine.unit_cost) * 1.01) flag = `Charged ${money(unitCost)}, PO expected ${money(poLine.unit_cost)}`;
    return {
      bill_id: bill.id, material_id: poLine?.material_id || null, description: l.description,
      quantity: Number(l.quantity) || 1, unit_cost: unitCost, po_line_item_id: poLine?.id || null, flag_reason: flag,
    };
  });
  if (lines.length) {
    const { error: lineErr } = await supabaseAdmin.from('supplier_bill_line_items').insert(lines);
    if (lineErr) throw lineErr;
  }

  await supabaseAdmin.from('supplier_bill_inbox').update({
    status: 'saved', bill_id: bill.id, po_id: po?.id || null, resolved_by: userId, resolved_at: new Date().toISOString(),
  }).eq('id', itemId);

  const who = userId ? '' : ' automatically';
  const desc = `Bill ${ex.bill_number || ''} (${money(ex.total)}) from ${supplier.name} saved${who} from an invoice@ email`.replace(/\s+/g, ' ');
  const log = [{ entity_type: 'supplier', entity_id: supplier.id, action: 'bill_emailed', description: desc + (po ? ` against ${po.po_number}` : ''), changed_by: userId }];
  if (po) log.push({ entity_type: 'purchase_order', entity_id: po.id, action: 'bill_emailed', description: desc, changed_by: userId });
  await supabaseAdmin.from('activity_log').insert(log);
  return bill.id;
}

// ---------- notifications ----------

async function notifyToCheck(supabaseAdmin, row, title) {
  const { data: people } = await supabaseAdmin.from('profiles').select('id').eq('active', true).in('role', ['admin', 'finance']);
  const from = row.extracted?.supplier || row.email_from || 'a supplier';
  for (const p of people || []) {
    await supabaseAdmin.rpc('create_notification', {
      p_user: p.id, p_kind: 'supplier_bill', p_title: title, p_body: `From ${from}${row.match_reason ? '. ' + row.match_reason : ''}`,
      p_link: '/supplier-bills.html', p_actor: null, p_dedupe: `supplier_bill:${row.id || row.gmail_message_id}`,
    });
  }
}

// ---------- the run ----------

async function autoSaveIsOn(supabaseAdmin) {
  const { data } = await supabaseAdmin.from('api_keys').select('key_value').eq('key_name', 'supplier_bill_auto_save').maybeSingle();
  return (data?.key_value || '').toLowerCase() === 'on';
}

async function processOne(supabaseAdmin, row, autoSave, usage) {
  const mime = (row.mime_type || '').toLowerCase();
  const mediaType = /\.pdf$/i.test(row.file_name || '') ? 'application/pdf' : mime;
  // a price list or catalogue (by its file name) goes to the price list reader unread here,
  // so a long catalogue is not read twice
  if (/price|pricing|catalog/i.test(row.file_name || '')) {
    await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'not_a_bill', match_confidence: 'none', match_reason: 'Looks like a price list: read on the Price lists page', extracted: { document_type: 'other' }, processed_at: new Date().toISOString(), error: null }).eq('id', row.id);
    return 'not_a_bill';
  }

  const buffer = await downloadAttachment(row.gmail_message_id, row.attachment_part_id);

  let filePath = row.file_path;
  if (!filePath) {
    const safeName = String(row.file_name || 'bill').replace(/[^a-zA-Z0-9._-]/g, '_');
    filePath = `bills/emailed/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${safeName}`;
    const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(filePath, buffer, { contentType: mediaType || 'application/octet-stream' });
    if (upErr) throw upErr;
    await supabaseAdmin.from('supplier_bill_inbox').update({ file_path: filePath }).eq('id', row.id);
  }

  if (!READABLE_MIME.includes(mediaType)) {
    const update = { status: 'to_check', match_confidence: 'none', match_reason: `This file type (${mime || 'unknown'}) cannot be read. Open it and enter the bill by hand.`, processed_at: new Date().toISOString(), error: null };
    await supabaseAdmin.from('supplier_bill_inbox').update(update).eq('id', row.id);
    await notifyToCheck(supabaseAdmin, { ...row, ...update }, 'An emailed bill needs checking');
    return 'to_check';
  }

  const read = await extractSupplierInvoiceWithUsage({ fileBase64: buffer.toString('base64'), mediaType });
  const extracted = read.extracted;
  usage.input_tokens += read.usage.input_tokens || 0;
  usage.output_tokens += read.usage.output_tokens || 0;
  const withExtract = { ...row, file_path: filePath, extracted };
  const result = await analyse(supabaseAdmin, withExtract);
  await supabaseAdmin.from('supplier_bill_inbox').update({ ...result, extracted, processed_at: new Date().toISOString(), error: null }).eq('id', row.id);

  if (autoSave && result.status === 'to_check' && result.match_confidence === 'confident' && result.supplier_id && result.po_id && (extracted.document_type || 'invoice') === 'invoice') {
    try {
      await saveInboxItemAsBill(supabaseAdmin, row.id, { poId: result.po_id, userId: null });
      return 'saved';
    } catch (err) {
      console.error('auto-save failed for', row.id, err.message);
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'to_check', match_reason: `${result.match_reason}. Auto-save failed: ${err.message}` }).eq('id', row.id);
    }
  }
  if (result.status === 'to_check') await notifyToCheck(supabaseAdmin, { ...withExtract, ...result }, 'An emailed bill needs checking');
  return result.status;
}

// Returns a summary. Safe to run twice at once: each row is claimed before it is read.
async function processSupplierBills({ budgetMs = 10 * 60 * 1000, extractAttachments, extractPlainText } = {}) {
  const startedAt = Date.now();
  const supabaseAdmin = getAdminClient();

  // a run that died part way leaves rows stuck in processing: put them back
  await supabaseAdmin.from('supplier_bill_inbox').update({ status: 'pending' })
    .eq('status', 'processing').lt('processed_at', new Date(Date.now() - 20 * 60 * 1000).toISOString());

  const queued = await enqueueNewBillEmails(supabaseAdmin, { extractAttachments, extractPlainText });
  const autoSave = await autoSaveIsOn(supabaseAdmin);
  const { data: pending } = await supabaseAdmin.from('supplier_bill_inbox').select('*').eq('status', 'pending').order('created_at').limit(25);

  const counts = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const row of pending || []) {
    if (Date.now() - startedAt > budgetMs) break;
    const { data: claimed } = await supabaseAdmin.from('supplier_bill_inbox')
      .update({ status: 'processing', attempts: row.attempts + 1, processed_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending').select('*').maybeSingle();
    if (!claimed) continue;
    try {
      const outcome = await processOne(supabaseAdmin, claimed, autoSave, usage);
      counts[outcome] = (counts[outcome] || 0) + 1;
    } catch (err) {
      console.error('supplier bill', row.id, 'failed:', err.message);
      const failed = claimed.attempts >= MAX_ATTEMPTS;
      await supabaseAdmin.from('supplier_bill_inbox').update({ status: failed ? 'failed' : 'pending', error: err.message.slice(0, 500) }).eq('id', row.id);
      if (failed) await notifyToCheck(supabaseAdmin, { ...claimed, match_reason: 'Could not be read: ' + err.message.slice(0, 120) }, 'An emailed bill could not be read');
      counts.error = (counts.error || 0) + 1;
    }
  }
  console.log(`supplier bills: queued ${queued}, processed`, JSON.stringify(counts), autoSave ? '(auto-save on)' : '(suggest only)');
  const { count: waiting } = await supabaseAdmin.from('supplier_bill_inbox').select('id', { count: 'exact', head: true }).in('status', ['to_check', 'failed']);
  return { queued, counts, usage, waiting: waiting || 0, autoSave };
}

module.exports = {
  INVOICE_ADDRESS, getBillLabelId, isSupplierBillMessage, findPart, startSupplierBillProcessing,
  processSupplierBills, analyse, saveInboxItemAsBill, matchPurchaseOrder, matchSupplier, fuzzyMatchScore, downloadAttachment,
};
