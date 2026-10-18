// Emailed price lists (backlog item 8, spec A11b, migration 20261019020000).
//
// Price lists can come to sales@ or invoice@ (invoice@ lands in sales@ too), so this looks at
// sales@ for emails whose subject or file name says price / pricing / catalogue, plus anything
// the bill reader put aside as "not a bill". Each PDF or spreadsheet becomes a
// price_list_imports row, read with _shared/price-list-ai.js. A big PDF is read a few pages at
// a time across runs (progress in pages_done); over MAX_PAGES it waits for a person to say
// "read all pages" so a 300-page brochure does not quietly cost a fortune.
//
// Once read, applyPriceList():
//   - keeps the supplier's whole list in supplier_price_items (searchable, with the last price);
//   - for each of our materials linked to one of their parts (material_supplier_links):
//       price moved under AUTO_LIMIT_PCT  -> cost price updated now (logged, can be undone);
//       moved more                        -> waits for a person;
//       part gone from the list, material not used for USED_RECENTLY_DAYS and a similar new
//       item is on the list               -> "looks replaced" waits for a person (never deleted);
//   - suggests links for our materials that are not linked yet (first list from a supplier,
//     or materials added since). A person confirms each once; after that matching is exact.
// Only material cost prices change (quotes and POs read cost_price). Never deletes anything.

const { getAdminClient } = require('./require-admin');
const { gmailRequest } = require('./google-client');
const { sharedMailboxId } = require('./mailboxes');
const { selfBaseUrl } = require('./site-url');
const fetch = require('node-fetch');
const { fuzzyMatchScore, matchSupplier, downloadAttachment } = require('./supplier-bill-intake');
const ai = require('./price-list-ai');

const AUTO_LIMIT_PCT = 20;
const USED_RECENTLY_DAYS = 180;
const MAX_PAGES = 60;
const PAGE_BATCH = 4;
const MAX_ATTEMPTS = 3;
const NAME_HINT = /price|pricing|catalog/i;
const GMAIL_QUERY = 'has:attachment newer_than:30d -in:sent (subject:(price OR prices OR pricing OR pricelist OR catalogue OR catalog) OR filename:(price OR prices OR pricing OR pricelist OR catalogue OR catalog))';
const SHEET_MIME = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv', 'application/csv'];
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const itemKey = (it) => (it.part_number ? 'p:' + norm(it.part_number).replace(/ /g, '') : 'd:' + norm(it.description));

function fileKind(name, mime) {
  const n = String(name || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (SHEET_MIME.includes(m) || /\.(xlsx|xls|csv)$/.test(n)) return 'sheet';
  if (IMAGE_MIME.includes(m)) return 'image';
  return null;
}

// Does this email look like it carries a price list? (subject or a file name says so, and it
// has a PDF or spreadsheet). Used by the Gmail sync to start the reader straight away.
function looksLikePriceListEmail(subject, attachments) {
  const files = (attachments || []).filter(a => !a.inline && ['pdf', 'sheet'].includes(fileKind(a.name, a.mime)));
  if (!files.length) return false;
  return NAME_HINT.test(subject || '') || files.some(f => NAME_HINT.test(f.name || ''));
}

async function startPriceListProcessing() {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/process-price-lists-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 8000,
    });
    if (!res.ok && res.status !== 202) console.error('price list processing did not start:', res.status);
  } catch (err) {
    console.error('price list processing did not start:', err.message);
  }
}

function headerValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

// ---------- finding them ----------

async function enqueue(admin, { extractAttachments }) {
  let added = 0;
  const list = await gmailRequest(`messages?maxResults=50&q=${encodeURIComponent(GMAIL_QUERY)}`);
  const ids = (list.messages || []).map(m => m.id);
  const known = new Set();
  if (ids.length) {
    const { data } = await admin.from('price_list_imports').select('gmail_message_id').in('gmail_message_id', ids);
    (data || []).forEach(r => known.add(r.gmail_message_id));
  }
  for (const id of ids.filter(i => !known.has(i))) {
    const msg = await gmailRequest(`messages/${id}?format=full`);
    const headers = msg.payload?.headers;
    const files = extractAttachments(msg.payload).filter(a => !a.inline && ['pdf', 'sheet'].includes(fileKind(a.name, a.mime)));
    if (!files.length) continue;
    const { data: email } = await admin.from('emails').select('id, email_threads!inner(mailbox_id)').eq('gmail_message_id', id).eq('email_threads.mailbox_id', await sharedMailboxId(admin)).maybeSingle();
    const date = headerValue(headers, 'Date');
    const rows = files.map(f => ({
      email_id: email?.id || null, gmail_message_id: id, attachment_part_id: String(f.part_id), file_name: f.name, mime_type: f.mime,
      email_from: headerValue(headers, 'From'), email_subject: headerValue(headers, 'Subject'),
      received_at: date ? new Date(date).toISOString() : new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    }));
    const { error } = await admin.from('price_list_imports').upsert(rows, { onConflict: 'gmail_message_id,attachment_part_id', ignoreDuplicates: true });
    if (error) throw error;
    added += rows.length;
  }

  // anything the bill reader set aside as not a bill (and not obviously a statement or credit note)
  const { data: others } = await admin.from('supplier_bill_inbox')
    .select('email_id, gmail_message_id, attachment_part_id, file_name, mime_type, email_from, email_subject, received_at, extracted')
    .in('status', ['to_check', 'not_a_bill']).eq('extracted->>document_type', 'other')
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).limit(50);
  for (const o of others || []) {
    if (!fileKind(o.file_name, o.mime_type)) continue;
    const { data, error } = await admin.from('price_list_imports').upsert({
      email_id: o.email_id, gmail_message_id: o.gmail_message_id, attachment_part_id: o.attachment_part_id, file_name: o.file_name,
      mime_type: o.mime_type, email_from: o.email_from, email_subject: o.email_subject, received_at: o.received_at,
    }, { onConflict: 'gmail_message_id,attachment_part_id', ignoreDuplicates: true }).select('id');
    if (error) throw error;
    added += (data || []).length;
  }
  return added;
}

// ---------- reading ----------

// Reads (or carries on reading) one import. Returns 'done' when every page is read,
// 'more' when time ran out part way, or a final status.
async function readImport(admin, row, { deadline, usage }) {
  const kind = fileKind(row.file_name, row.mime_type);
  const buffer = await downloadAttachment(row.gmail_message_id, row.attachment_part_id);

  if (!row.file_path) {
    const safeName = String(row.file_name || 'price-list').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `price-lists/emailed/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${safeName}`;
    const { error } = await admin.storage.from('project-documents').upload(path, buffer, { contentType: row.mime_type || 'application/octet-stream' });
    if (error) throw error;
    row.file_path = path;
    await admin.from('price_list_imports').update({ file_path: path }).eq('id', row.id);
  }

  if (kind === 'sheet' || kind === 'image') {
    const r = kind === 'sheet' ? await ai.readSpreadsheet({ buffer, usage })
      : await ai.readFirstPages({ fileBase64: buffer.toString('base64'), mediaType: row.mime_type, usage });
    if (r.truncated) throw new Error('The photo has too many items to read in one go.');
    await admin.from('price_list_imports').update({ items: r.items || [], read_meta: { is_price_list: r.is_price_list, supplier: r.supplier, abn: r.abn, our_account_number: r.our_account_number }, supplier_name_read: r.supplier || null }).eq('id', row.id);
    return r.is_price_list ? 'done' : 'not_a_price_list';
  }

  // PDF, a few pages at a time
  const total = row.pages_total || await ai.pdfPageCount(buffer);
  if (!row.pages_total) await admin.from('price_list_imports').update({ pages_total: total }).eq('id', row.id);
  if (total > MAX_PAGES && !row.allow_large) return 'too_large';
  let done = row.pages_done || 0;
  let items = row.items || [];
  let meta = row.read_meta;
  while (done < total) {
    if (Date.now() > deadline) return 'more';
    const count = Math.min(PAGE_BATCH, total - done);
    const r = await ai.readPdfRange(buffer, done, count, usage, done === 0);
    if (done === 0) {
      meta = { is_price_list: r.is_price_list, supplier: r.supplier, abn: r.abn, our_account_number: r.our_account_number };
      if (!r.is_price_list) {
        await admin.from('price_list_imports').update({ read_meta: meta, supplier_name_read: r.supplier || null }).eq('id', row.id);
        return 'not_a_price_list';
      }
    }
    items = items.concat(r.items || []);
    done += count;
    await admin.from('price_list_imports').update({ items, pages_done: done, read_meta: meta, supplier_name_read: meta.supplier || null }).eq('id', row.id);
  }
  return 'done';
}

// ---------- comparing with our materials ----------

async function recentlyUsedMaterialIds(admin, ids) {
  if (!ids.length) return new Set();
  const since = new Date(Date.now() - USED_RECENTLY_DAYS * 86400000).toISOString();
  const used = new Set();
  for (const table of ['purchase_order_line_items', 'supplier_bill_line_items', 'job_material_usage']) {
    const { data } = await admin.from(table).select('material_id').in('material_id', ids).gte('created_at', since);
    (data || []).forEach(r => used.add(r.material_id));
  }
  return used;
}

async function setMaterialCost(admin, materialId, cost, extra = {}) {
  const { error } = await admin.from('materials').update({ cost_price: cost, ...extra }).eq('id', materialId);
  if (error) throw error;
}

async function logMaterial(admin, materialId, description, userId) {
  await admin.from('activity_log').insert({ entity_type: 'material', entity_id: materialId, action: 'price_list', description, changed_by: userId || null });
}

// Turns a fully read import into supplier_price_items and price_changes. Safe to run again
// (e.g. after the supplier is picked by hand).
async function applyPriceList(admin, importId) {
  const { data: imp } = await admin.from('price_list_imports').select('*').eq('id', importId).single();
  const sid = imp.supplier_id;
  const { data: supplier } = await admin.from('suppliers').select('id, name').eq('id', sid).single();

  // the supplier's list, one row per part (the last price wins if a part is listed twice)
  const byKey = new Map();
  (imp.items || []).forEach(it => {
    const cost = ai.toNumber(it.unit_cost);
    if (!it.description || cost == null || cost <= 0) return;
    byKey.set(itemKey(it), { item_key: itemKey(it), part_number: it.part_number || null, description: String(it.description).slice(0, 500), unit_cost: Math.round(cost * 10000) / 10000 });
  });
  const { data: existing } = await admin.from('supplier_price_items').select('id, item_key, unit_cost').eq('supplier_id', sid);
  const prev = new Map((existing || []).map(e => [e.item_key, e]));
  const now = new Date().toISOString();
  const upserts = [...byKey.values()].map(it => ({
    supplier_id: sid, ...it, last_import_id: imp.id, last_seen_at: now,
    previous_cost: prev.has(it.item_key) && Number(prev.get(it.item_key).unit_cost) !== it.unit_cost ? prev.get(it.item_key).unit_cost : (prev.get(it.item_key)?.previous_cost ?? null),
  }));
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await admin.from('supplier_price_items').upsert(upserts.slice(i, i + 500), { onConflict: 'supplier_id,item_key' });
    if (error) throw error;
  }
  const { data: spiRows } = await admin.from('supplier_price_items').select('id, item_key, part_number, description, unit_cost').eq('supplier_id', sid);
  const spi = new Map((spiRows || []).map(r => [r.item_key, r]));
  const onList = (key) => byKey.has(key) ? spi.get(key) : null;

  // an older list's suggestions for this supplier are out of date now
  await admin.from('price_changes').update({ status: 'skipped', reason: 'Replaced by a newer price list', resolved_at: now })
    .eq('supplier_id', sid).eq('status', 'waiting');

  const { data: links } = await admin.from('material_supplier_links').select('*').eq('supplier_id', sid);
  const linkList = links || [];
  const { data: mats } = await admin.from('materials').select('id, name, cost_price, supplier_id');
  const materials = new Map((mats || []).map(m => [m.id, m]));
  const linkedKeys = new Set(linkList.map(l => l.item_key));
  const first = !linkList.length;
  const changes = [];
  let autoApplied = 0;

  // 1. linked materials: price moves and parts that have gone
  const missing = [];
  for (const link of linkList) {
    const m = materials.get(link.material_id);
    if (!m) continue;
    const item = onList(link.item_key);
    if (!item) { missing.push({ link, m }); continue; }
    const oldCost = Number(m.cost_price) || 0;
    if (Math.abs(item.unit_cost - oldCost) < 0.005) continue;
    const pct = oldCost ? ((item.unit_cost - oldCost) / oldCost) * 100 : null;
    const base = { import_id: imp.id, material_id: m.id, supplier_id: sid, supplier_price_item_id: item.id, kind: 'price', old_cost: oldCost, new_cost: item.unit_cost, change_pct: pct == null ? null : Math.round(pct * 10) / 10 };
    if (pct != null && Math.abs(pct) < AUTO_LIMIT_PCT) {
      await setMaterialCost(admin, m.id, item.unit_cost);
      await logMaterial(admin, m.id, `Cost ${money(oldCost)} -> ${money(item.unit_cost)} from ${supplier.name}'s emailed price list (automatic)`, null);
      changes.push({ ...base, status: 'applied', resolved_at: now, reason: `Small change (${base.change_pct > 0 ? '+' : ''}${base.change_pct}%), applied automatically` });
      autoApplied += 1;
    } else {
      changes.push({ ...base, status: 'waiting', reason: pct == null ? 'Our cost was $0' : `Big change (${base.change_pct > 0 ? '+' : ''}${base.change_pct}%), check before applying` });
    }
  }

  // 2. parts no longer on the list: flag only if not used lately and something similar replaced it
  const unusedIds = missing.map(x => x.m.id);
  const used = await recentlyUsedMaterialIds(admin, unusedIds);
  const freeItems = [...byKey.keys()].filter(k => !linkedKeys.has(k)).map(k => spi.get(k)).filter(Boolean);
  for (const { link, m } of missing) {
    if (used.has(m.id)) continue;
    let best = null, bestScore = 0;
    freeItems.forEach(it => { const s = fuzzyMatchScore(link.supplier_description || m.name, it.description); if (s > bestScore) { bestScore = s; best = it; } });
    if (!best || bestScore < 0.5) continue;
    changes.push({
      import_id: imp.id, material_id: m.id, supplier_id: sid, supplier_price_item_id: best.id, kind: 'superseded',
      old_cost: Number(m.cost_price) || 0, new_cost: best.unit_cost, old_name: m.name, new_name: best.description, old_item_key: link.item_key,
      change_pct: Number(m.cost_price) ? Math.round(((best.unit_cost - m.cost_price) / m.cost_price) * 1000) / 10 : null,
      status: 'waiting', reason: `${link.part_number || m.name} is no longer on the list and has not been used for ${USED_RECENTLY_DAYS / 30} months. ${best.part_number || 'This item'} looks like its replacement.`,
    });
  }

  // 3. our materials not linked to this supplier yet: suggest a match (confirmed once by a person)
  const { data: skipped } = await admin.from('price_changes').select('material_id, supplier_price_item_id').eq('supplier_id', sid).eq('kind', 'match').eq('status', 'skipped');
  const declined = new Set((skipped || []).map(s => `${s.material_id}:${s.supplier_price_item_id}`));
  const linkedMaterialIds = new Set(linkList.map(l => l.material_id));
  const suggestions = [];
  for (const m of materials.values()) {
    if (linkedMaterialIds.has(m.id)) continue;
    if (m.supplier_id && m.supplier_id !== sid) continue;
    const need = m.supplier_id === sid ? 0.5 : 0.6;
    let best = null, bestScore = 0;
    freeItems.forEach(it => { const s = fuzzyMatchScore(m.name, it.description); if (s > bestScore) { bestScore = s; best = it; } });
    if (!best || bestScore < need || declined.has(`${m.id}:${best.id}`)) continue;
    const oldCost = Number(m.cost_price) || 0;
    suggestions.push({
      import_id: imp.id, material_id: m.id, supplier_id: sid, supplier_price_item_id: best.id, kind: 'match', status: 'waiting',
      old_cost: oldCost, new_cost: best.unit_cost, change_pct: oldCost ? Math.round(((best.unit_cost - oldCost) / oldCost) * 1000) / 10 : null,
      old_name: m.name, new_name: best.description, score: bestScore,
      reason: `Is our "${m.name}" their ${best.part_number ? best.part_number + ' ' : ''}"${best.description}"? Confirm once and future lists update it automatically.`,
    });
  }
  suggestions.sort((a, b) => b.score - a.score).slice(0, 200).forEach(({ score, ...s }) => changes.push(s));

  for (let i = 0; i < changes.length; i += 500) {
    const { error } = await admin.from('price_changes').insert(changes.slice(i, i + 500));
    if (error) throw error;
  }

  const waiting = changes.filter(c => c.status === 'waiting').length;
  const parts = [`${byKey.size} items read`];
  if (autoApplied) parts.push(`${autoApplied} price${autoApplied === 1 ? '' : 's'} updated`);
  const big = changes.filter(c => c.kind === 'price' && c.status === 'waiting').length;
  if (big) parts.push(`${big} big change${big === 1 ? '' : 's'} to check`);
  const matches = changes.filter(c => c.kind === 'match').length;
  if (matches) parts.push(`${matches} match${matches === 1 ? '' : 'es'} to confirm`);
  const replaced = changes.filter(c => c.kind === 'superseded').length;
  if (replaced) parts.push(`${replaced} look${replaced === 1 ? 's' : ''} replaced`);
  const summary = `${supplier.name}: ${parts.join(', ')}`;
  await admin.from('price_list_imports').update({
    status: waiting ? 'to_check' : 'applied', first_for_supplier: first, item_count: byKey.size, auto_applied: autoApplied, waiting, summary, processed_at: now, error: null,
  }).eq('id', imp.id);
  // the bill reader's copy of this file is handled here now
  await admin.from('supplier_bill_inbox').update({ status: 'not_a_bill', match_reason: 'Price list: handled on the Price lists page' })
    .eq('gmail_message_id', imp.gmail_message_id).eq('attachment_part_id', imp.attachment_part_id).in('status', ['to_check', 'failed']);
  return { summary, autoApplied, waiting, items: byKey.size };
}

// ---------- a person's decisions ----------

async function applyChange(admin, changeId, userId) {
  const { data: c } = await admin.from('price_changes').select('*').eq('id', changeId).single();
  if (c.status !== 'waiting') throw new Error('That change has already been dealt with.');
  const { data: item } = c.supplier_price_item_id
    ? await admin.from('supplier_price_items').select('item_key, part_number, description, unit_cost').eq('id', c.supplier_price_item_id).maybeSingle()
    : { data: null };
  if (!item) throw new Error('That item is no longer on the supplier list.');
  const { data: sup } = await admin.from('suppliers').select('name').eq('id', c.supplier_id).maybeSingle();
  c.suppliers = sup;
  const now = new Date().toISOString();
  if (c.kind === 'match' || c.kind === 'superseded') {
    const { error } = await admin.from('material_supplier_links').upsert({
      material_id: c.material_id, supplier_id: c.supplier_id, item_key: item.item_key, part_number: item.part_number, supplier_description: item.description, confirmed_by: userId,
    }, { onConflict: 'material_id,supplier_id' });
    if (error) throw error;
  }
  await setMaterialCost(admin, c.material_id, c.new_cost, c.kind === 'superseded' ? { name: c.new_name } : (c.kind === 'match' ? { supplier_id: c.supplier_id } : {}));
  await admin.from('price_changes').update({ status: 'applied', resolved_by: userId, resolved_at: now }).eq('id', c.id);
  const what = c.kind === 'superseded' ? `Switched from "${c.old_name}" to "${c.new_name}", cost` : (c.kind === 'match' ? `Linked to ${c.suppliers?.name} ${item.part_number || item.description}, cost` : 'Cost');
  await logMaterial(admin, c.material_id, `${what} ${money(c.old_cost)} -> ${money(c.new_cost)} from ${c.suppliers?.name || 'a supplier'}'s emailed price list`, userId);
  await refreshImportCounts(admin, c.import_id);
}

async function skipChange(admin, changeId, userId) {
  await admin.from('price_changes').update({ status: 'skipped', resolved_by: userId, resolved_at: new Date().toISOString() }).eq('id', changeId).eq('status', 'waiting');
  const { data: c } = await admin.from('price_changes').select('import_id').eq('id', changeId).single();
  await refreshImportCounts(admin, c.import_id);
}

async function undoChange(admin, changeId, userId) {
  const { data: c } = await admin.from('price_changes').select('*').eq('id', changeId).single();
  if (c.status !== 'applied') throw new Error('Only an applied change can be undone.');
  const { data: m } = await admin.from('materials').select('cost_price').eq('id', c.material_id).single();
  if (Math.abs((Number(m.cost_price) || 0) - Number(c.new_cost)) > 0.005) throw new Error('The cost has been changed again since, so this cannot be undone safely. Edit it on the Stock page.');
  if (c.kind === 'match') await admin.from('material_supplier_links').delete().eq('material_id', c.material_id).eq('supplier_id', c.supplier_id);
  if (c.kind === 'superseded' && c.old_item_key) {
    await admin.from('material_supplier_links').update({ item_key: c.old_item_key }).eq('material_id', c.material_id).eq('supplier_id', c.supplier_id);
  }
  await setMaterialCost(admin, c.material_id, c.old_cost, c.kind === 'superseded' && c.old_name ? { name: c.old_name } : {});
  await admin.from('price_changes').update({ status: 'undone', resolved_by: userId, resolved_at: new Date().toISOString() }).eq('id', c.id);
  await logMaterial(admin, c.material_id, `Price list change undone: cost back to ${money(c.old_cost)}`, userId);
}

async function refreshImportCounts(admin, importId) {
  if (!importId) return;
  const { count } = await admin.from('price_changes').select('id', { count: 'exact', head: true }).eq('import_id', importId).eq('status', 'waiting');
  await admin.from('price_list_imports').update({ waiting: count || 0, ...(count ? {} : { status: 'applied' }) }).eq('id', importId).in('status', ['to_check', 'applied']);
}

// ---------- the run ----------

async function notifyCheckers(admin, title, body) {
  const { data: people } = await admin.from('profiles').select('id').eq('active', true).in('role', ['admin', 'finance']);
  for (const p of people || []) {
    await admin.rpc('create_notification', { p_user: p.id, p_kind: 'price_list', p_title: title, p_body: body.slice(0, 300), p_link: '/price-lists.html', p_actor: null, p_dedupe: `price_list:${title}:${new Date().toISOString().slice(0, 13)}` });
  }
}

async function processPriceLists({ budgetMs = 12 * 60 * 1000, extractAttachments } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const admin = getAdminClient();
  const usage = { input_tokens: 0, output_tokens: 0 };

  await admin.from('price_list_imports').update({ status: 'pending' }).eq('status', 'processing').lt('processed_at', new Date(Date.now() - 20 * 60000).toISOString());
  const queued = await enqueue(admin, { extractAttachments });
  const { data: suppliers } = await admin.from('suppliers').select('*');
  const { data: pending } = await admin.from('price_list_imports').select('*').eq('status', 'pending').order('created_at').limit(10);

  const results = [];
  for (const row of pending || []) {
    if (Date.now() > deadline) break;
    const { data: claimed } = await admin.from('price_list_imports')
      .update({ status: 'processing', attempts: row.attempts + 1, processed_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'pending').select('*').maybeSingle();
    if (!claimed) continue;
    try {
      const outcome = await readImport(admin, claimed, { deadline, usage });
      if (outcome === 'more') { await admin.from('price_list_imports').update({ status: 'pending', attempts: 0 }).eq('id', row.id); results.push('more'); continue; }
      if (outcome === 'too_large') {
        await admin.from('price_list_imports').update({ status: 'too_large', summary: `${claimed.pages_total || 'Over ' + MAX_PAGES} pages. Tap "Read all pages" if it is worth reading.` }).eq('id', row.id);
        results.push('too_large'); continue;
      }
      if (outcome === 'not_a_price_list') { await admin.from('price_list_imports').update({ status: 'not_a_price_list', summary: 'Not a price list' }).eq('id', row.id); results.push('not'); continue; }

      const { data: fresh } = await admin.from('price_list_imports').select('*').eq('id', row.id).single();
      const meta = fresh.read_meta || {};
      const match = matchSupplier(suppliers, { supplier: meta.supplier, abn: meta.abn, our_account_number: meta.our_account_number });
      if (!match) {
        await admin.from('price_list_imports').update({ status: 'to_check', item_count: (fresh.items || []).length, summary: `${(fresh.items || []).length} items read. Supplier "${meta.supplier || 'unknown'}" not recognised: pick the supplier.` }).eq('id', row.id);
        await notifyCheckers(admin, 'An emailed price list needs its supplier picked', `"${meta.supplier || fresh.file_name}" was not recognised.`);
        results.push('to_check'); continue;
      }
      await admin.from('price_list_imports').update({ supplier_id: match.supplier.id }).eq('id', row.id);
      const r = await applyPriceList(admin, row.id);
      if (r.waiting) await notifyCheckers(admin, 'Price list changes to check', r.summary);
      results.push(r.summary);
    } catch (err) {
      console.error('price list', row.id, 'failed:', err.message);
      const failed = claimed.attempts >= MAX_ATTEMPTS;
      await admin.from('price_list_imports').update({ status: failed ? 'failed' : 'pending', error: err.message.slice(0, 500) }).eq('id', row.id);
      results.push('error');
    }
  }

  const { count: waiting } = await admin.from('price_changes').select('id', { count: 'exact', head: true }).eq('status', 'waiting');
  const { count: more } = await admin.from('price_list_imports').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return { queued, results, usage, waiting: waiting || 0, more: more || 0 };
}

module.exports = {
  processPriceLists, applyPriceList, applyChange, skipChange, undoChange, looksLikePriceListEmail, startPriceListProcessing,
  fileKind, itemKey, NAME_HINT, AUTO_LIMIT_PCT,
};
