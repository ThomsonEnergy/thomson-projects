// The quotes suppliers send back to a request for quote (backlog item 81), filed and read by
// themselves.
//   sweepSupplierQuotes(admin, usage)   every run of the mailbox worker (mailbox-work-background.js):
//     for each request sent in the last 120 days, the inbound emails on its own conversation, and the
//     emails from that supplier on the job's other conversations that name the RFQ, with a file not
//     filed yet: the file into the job's Documents under Supplier quotes, a supplier_quotes row, then
//     readSupplierQuote. Then any row still waiting to be read.
//   readSupplierQuote(admin, quoteId, usage)   Tally (_shared/supplier-invoice-ai.js) reads the
//     file: their quote number and date, the lines (matched to the request's lines so the Stock item
//     carries over), the total ex GST. The row becomes quoted, pricing roles get a bell, the job's
//     log gets a line. A file Tally cannot read is still quoted (no lines, read_error): Approve then
//     makes an open PO and the bill fills in the lines.
// Writes: project_documents, supplier_quotes, supplier_quote_lines, emails.attachments[].saved_to,
// activity_log, notifications (create_notification).

const { downloadAttachment } = require('./google-client');
const { mailboxById } = require('./mailboxes');
const { extractSupplierInvoiceWithUsage } = require('./supplier-invoice-ai');
const { safeName, fileNameWithExt, markAttachmentSaved } = require('./email-attachment-files');

const FOLDER = 'Supplier quotes';
const READABLE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const FILE_MIME = [...READABLE_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/csv'];
const SMALL_PICTURE = 60 * 1024; // a logo or signature picture, never a quote
const MAX_BYTES = 25 * 1024 * 1024;
const LOOK_BACK_DAYS = 120;
const MATCH_SCORE = 0.3; // the same bar as fuzzyMatchScore in the browser (supabase-client.js)
const FREE_MAIL = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'bigpond.com', 'live.com'];

const money = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n) || 0);
const lowerAddr = (s) => String(s || '').toLowerCase().replace(/^.*<|>.*$/g, '').trim();
const domainOf = (addr) => lowerAddr(addr).split('@')[1] || '';

// How alike two item names are, 0 to 1 (words over two letters in common): the server-side twin of
// fuzzyMatchScore in public/js/supabase-client.js (the browser file cannot be required here).
function wordScore(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const wordsA = new Set(norm(a));
  const wordsB = norm(b);
  if (!wordsA.size || !wordsB.length) return 0;
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  return matches / Math.max(wordsA.size, wordsB.length);
}
const normCode = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// RFQ plus the quote's number (also on the job it became), or the J number: the same rule as
// supplier_quote_rfq_number in the database and rfqNumber in js/supplier-quotes.js.
async function projectRfq(admin, projectId) {
  const { data: p } = await admin.from('projects').select('id, name, quote_number, job_number, source_quote_id').eq('id', projectId).maybeSingle();
  if (!p) return null;
  // The quote a job was made from, read by its id: an embed (projects!source_quote_id) on a table
  // that points at itself returns the jobs made from a row, not the quote it came from (item 86).
  const { data: sourceQuote } = !p.quote_number && p.source_quote_id
    ? await admin.from('projects').select('quote_number').eq('id', p.source_quote_id).maybeSingle() : { data: null };
  return { ...p, rfq: 'RFQ' + (p.quote_number || (sourceQuote && sourceQuote.quote_number) || p.job_number || ''), ref: p.job_number ? `J${p.job_number}` : (p.quote_number ? `Q${p.quote_number}` : p.name) };
}

// ---------- the sweep ----------

function filesWorthFiling(email) {
  return (email.attachments || []).filter(a => a.part_id !== undefined && a.part_id !== null && !a.storage && !a.inline)
    .filter(a => FILE_MIME.includes(String(a.mime || '').toLowerCase()))
    .filter(a => !(String(a.mime || '').startsWith('image/') && (a.size || 0) < SMALL_PICTURE))
    .filter(a => (a.size || 0) <= MAX_BYTES);
}

// The supplier's replies: on the request's own conversation, and from the supplier's address on any
// other conversation tagged to the job (or the quote it came from) that names the RFQ.
async function candidateEmails(admin, req, project) {
  const cols = 'id, thread_id, gmail_message_id, direction, from_address, subject, body_text, attachments, sent_at';
  const out = [];
  if (req.email_thread_id) {
    const { data } = await admin.from('emails').select(cols).eq('thread_id', req.email_thread_id).eq('direction', 'inbound').gt('sent_at', req.sent_at).order('sent_at');
    out.push(...(data || []));
  }
  const addresses = [req.sent_to, req.suppliers && req.suppliers.contact_email].map(lowerAddr).filter(Boolean);
  const projectIds = [project.id, project.source_quote_id].filter(Boolean);
  const { data: links } = await admin.from('email_job_links').select('thread_id').in('project_id', projectIds);
  const threadIds = [...new Set((links || []).map(l => l.thread_id))].filter(t => t !== req.email_thread_id);
  if (threadIds.length && addresses.length) {
    const { data } = await admin.from('emails').select(cols).in('thread_id', threadIds).eq('direction', 'inbound').gt('sent_at', req.sent_at).order('sent_at');
    const rfqRe = new RegExp(project.rfq.replace(/^RFQ/i, 'RFQ\\s*'), 'i');
    for (const e of data || []) {
      const from = lowerAddr(e.from_address);
      const sameSender = addresses.includes(from) || (domainOf(from) && !FREE_MAIL.includes(domainOf(from)) && addresses.some(a => domainOf(a) === domainOf(from)));
      if (!sameSender) continue;
      if (!rfqRe.test(`${e.subject || ''}\n${e.body_text || ''}`)) continue;
      out.push(e);
    }
  }
  return out.filter((e, i, all) => all.findIndex(x => x.id === e.id) === i);
}

async function fileAttachment(admin, req, project, email, att) {
  const { data: thread } = await admin.from('email_threads').select('mailbox_id').eq('id', email.thread_id).maybeSingle();
  const mailbox = await mailboxById(admin, thread && thread.mailbox_id);
  if (!mailbox) throw new Error('mailbox not found for the conversation');
  const buf = await downloadAttachment(email.gmail_message_id, att.part_id, mailbox);
  if (buf.length > MAX_BYTES) throw new Error('file over 25 MB');
  const mime = String(att.mime || 'application/octet-stream').toLowerCase();
  const fileName = fileNameWithExt(att.name, mime).slice(0, 140);
  const path = `documents/${project.id}/${Date.now()}-${safeName(fileName)}`;
  const { error: upErr } = await admin.storage.from('project-documents').upload(path, buf, { contentType: mime });
  if (upErr) throw upErr;
  const { data: doc, error: dErr } = await admin.from('project_documents').insert({ project_id: project.id, folder: FOLDER, file_path: path, file_name: fileName, mime_type: mime, uploaded_by: null }).select('id').single();
  if (dErr) { await admin.storage.from('project-documents').remove([path]).catch(() => {}); throw dErr; }
  const { data: made, error } = await admin.from('supplier_quotes').insert({
    project_id: project.id, supplier_id: req.supplier_id, request_id: req.id, document_id: doc.id,
    file_path: path, file_name: fileName, mime_type: mime, email_id: email.id, attachment_part_id: String(att.part_id), status: 'reading',
  }).select('id').single();
  if (error) {
    // the same attachment filed by another run a moment ago: keep that one
    await admin.from('project_documents').delete().eq('id', doc.id);
    await admin.storage.from('project-documents').remove([path]).catch(() => {});
    if (/duplicate|unique/i.test(error.message)) return null;
    throw error;
  }
  await markAttachmentSaved(admin, email.id, att.part_id, project.id, { kind: 'document', id: doc.id });
  return made.id;
}

async function sweepSupplierQuotes(admin, usage) {
  const since = new Date(Date.now() - LOOK_BACK_DAYS * 86400000).toISOString();
  const { data: requests } = await admin.from('supplier_quote_requests')
    .select('id, project_id, supplier_id, sent_to, sent_at, email_thread_id, suppliers(name, contact_email)')
    .eq('status', 'sent').gte('sent_at', since).order('sent_at');
  let filed = 0, read = 0;
  const projects = {};
  for (const req of requests || []) {
    try {
      projects[req.project_id] = projects[req.project_id] || await projectRfq(admin, req.project_id);
      const project = projects[req.project_id];
      if (!project) continue;
      const emails = await candidateEmails(admin, req, project);
      for (const email of emails) {
        for (const att of filesWorthFiling(email)) {
          const { count } = await admin.from('supplier_quotes').select('id', { count: 'exact', head: true }).eq('email_id', email.id).eq('attachment_part_id', String(att.part_id));
          if (count) continue;
          if (await fileAttachment(admin, req, project, email, att)) filed += 1;
        }
      }
    } catch (err) {
      console.error(`supplier quote sweep, request ${req.id}:`, err.message);
    }
  }
  const { data: waiting } = await admin.from('supplier_quotes').select('id').eq('status', 'reading').order('created_at').limit(10);
  for (const q of waiting || []) {
    try { await readSupplierQuote(admin, q.id, usage); read += 1; } catch (err) {
      console.error(`supplier quote ${q.id} could not be read:`, err.message);
      await admin.from('supplier_quotes').update({ status: 'quoted', read_error: `Could not be read: ${String(err.message).slice(0, 160)}` }).eq('id', q.id);
      await tellPricingRoles(admin, q.id);
    }
  }
  return { filed, read };
}

// ---------- the reading ----------

async function readSupplierQuote(admin, quoteId, usage) {
  const { data: q } = await admin.from('supplier_quotes').select('*, suppliers(name), supplier_quote_requests(lines)').eq('id', quoteId).maybeSingle();
  if (!q) throw new Error('Supplier quote not found');
  if (!q.file_path) throw new Error('No file on this supplier quote');
  const mediaType = /\.pdf$/i.test(q.file_name || '') ? 'application/pdf' : String(q.mime_type || '').toLowerCase();
  if (!READABLE_MIME.includes(mediaType)) {
    await admin.from('supplier_quotes').update({ status: 'quoted', read_error: `This file type (${mediaType || 'unknown'}) cannot be read by Tally. Open it and check the prices on the PO.` }).eq('id', q.id);
    await tellPricingRoles(admin, q.id);
    return { lines: 0, total: null };
  }
  const { data: blob, error: dlErr } = await admin.storage.from('project-documents').download(q.file_path);
  if (dlErr || !blob) throw new Error(dlErr ? dlErr.message : 'Could not open the file');
  const buffer = Buffer.from(await blob.arrayBuffer());
  const { extracted, usage: used } = await extractSupplierInvoiceWithUsage({ fileBase64: buffer.toString('base64'), mediaType });
  if (usage) { usage.input_tokens += used.input_tokens || 0; usage.output_tokens += used.output_tokens || 0; }

  // their lines, each matched to a line we asked for (part number first, then the wording) so the
  // Stock item carries over onto the PO
  const asked = Array.isArray(q.supplier_quote_requests && q.supplier_quote_requests.lines) ? q.supplier_quote_requests.lines : [];
  const lines = (extracted.line_items || []).map((l, i) => {
    const qty = Number(l.quantity);
    const cost = l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost);
    let match = null, best = 0;
    const code = normCode(l.part_number);
    if (code) match = asked.find(a => a.part_number && normCode(a.part_number) === code) || null;
    if (!match) asked.forEach(a => { const s = wordScore(a.description, l.description); if (s > best) { best = s; match = a; } });
    if (!code && best < MATCH_SCORE) match = null;
    return {
      quote_id: q.id, material_id: match && match.material_id ? match.material_id : null,
      description: String(l.description || '').trim().slice(0, 500) || 'Item', part_number: l.part_number ? String(l.part_number).slice(0, 80) : null,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 0, unit: l.unit ? String(l.unit).slice(0, 20) : null,
      unit_cost: Number.isFinite(cost) ? cost : null, sort_order: i,
    };
  });
  await admin.from('supplier_quote_lines').delete().eq('quote_id', q.id);
  if (lines.length) {
    const { error } = await admin.from('supplier_quote_lines').insert(lines);
    if (error) throw error;
  }
  const summed = lines.reduce((t, l) => t + (l.quantity || 0) * (l.unit_cost || 0), 0);
  const subtotal = Number(extracted.subtotal);
  const total = Number.isFinite(subtotal) && subtotal > 0 ? subtotal : (summed > 0 ? Math.round(summed * 100) / 100 : null);
  const quotedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.bill_date || '')) ? extracted.bill_date : null;
  const { error: upErr } = await admin.from('supplier_quotes').update({
    status: 'quoted', read_error: null, reading: extracted, total,
    supplier_quote_number: extracted.bill_number ? String(extracted.bill_number).slice(0, 60) : null, quoted_on: quotedOn,
  }).eq('id', q.id);
  if (upErr) throw upErr;
  await tellPricingRoles(admin, q.id);
  return { lines: lines.length, total };
}

// A bell for Admin, Finance and Sales, once per quote, and a line in the job's log.
async function tellPricingRoles(admin, quoteId) {
  const { data: q } = await admin.from('supplier_quotes').select('id, project_id, supplier_id, total, read_error, supplier_quote_number, suppliers(name), supplier_quote_lines(id)').eq('id', quoteId).maybeSingle();
  if (!q) return;
  const project = await projectRfq(admin, q.project_id);
  if (!project) return;
  const who = (q.suppliers && q.suppliers.name) || 'A supplier';
  const n = (q.supplier_quote_lines || []).length;
  const title = `${who} quoted ${project.rfq}${q.total != null ? ': ' + money(q.total) + ' ex GST' : ''}`;
  const body = q.read_error ? `${q.read_error} Open the Supplier quotes tab on ${project.ref}.` : `${n} line${n === 1 ? '' : 's'} read. Approve or Deny on the Supplier quotes tab of ${project.ref}.`;
  await admin.from('activity_log').insert({ entity_type: 'project', entity_id: q.project_id, action: 'supplier_quote_received', description: `${project.rfq}: ${who}'s quote ${q.supplier_quote_number || ''} filed${q.total != null ? ', ' + money(q.total) + ' ex GST' : ''}`.replace(/\s+/g, ' '), changed_by: null });
  const { data: people } = await admin.from('profiles').select('id').eq('active', true).in('role', ['admin', 'finance', 'sales']);
  for (const p of people || []) {
    await admin.rpc('create_notification', {
      p_user: p.id, p_kind: 'supplier_quote', p_title: title, p_body: body,
      p_link: `/project.html?id=${q.project_id}&tab=supplier-quotes`, p_actor: null, p_dedupe: `supplier_quote:${q.id}`,
    });
  }
}

module.exports = { sweepSupplierQuotes, readSupplierQuote, FOLDER };
