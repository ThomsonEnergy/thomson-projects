// Supplier quotes tab on a quote or a job (backlog item 81). Loaded by project.html when the tab
// opens (pricing roles):  mountSupplierQuotes({ el, project, centres, onPoMade })
//
// Left card, Asked: one row per supplier asked (supplier_quote_requests). Ask suppliers for prices
// picks the suppliers (the shared picker, each one a chip), the lines come in from the quote's
// material lines matched to Stock (fuzzyMatchScore, as Suggest POs does), and plans or other files
// can go with it (a builder's plan and "please quote": then the lines are optional). The files go
// into Documents > Supplier quotes and are kept on the request (attachments), so every supplier's
// email and Send again carry them already ticked. Send makes the request PDF when there are lines
// (generate-client-document-pdf, supplier_quote_request: po.html in request mode) and opens the
// email window to each supplier in turn with it attached, tagged to the job as Materials quote.
// The request number is RFQ plus the quote's number (RFQ1017), the same for every supplier asked.
// Right card, Quotes in: one row per quote a supplier sent back (supplier_quotes, filed by the
// mailbox worker from the reply, by Save to job, or by Attach a supplier's quote here), its lines
// as Tally read them, Approve (supplier_quote_approve: the PO in one step, then the usual "PO
// created: Email it to the supplier now" panel) and Deny.
// Writes: supplier_quote_requests, supplier_quotes (Deny, Attach), project_documents (Attach),
// activity_log. Needs supabase-client.js (supabaseClient, escapeHtml, money, poQty, openModal,
// showToast, friendlyError, logActivity, supplierPickerHtml, wireSupplierPicker, fuzzyMatchScore,
// uploadPrivateFile, openSignedDocInNewTab, showPoCreatedPanel, emailPurchaseOrder) and
// email-compose.js (openEmailComposer, emailLocalFilePicker).

const SQ_MATCH_SCORE = 0.3; // the same bar as Suggest POs on the job page
const SQ_FOLDER = 'Supplier quotes';

// RFQ1017 for Q1017, also on the job it became; a job with no quote uses its J number.
function rfqNumber(project) {
  return 'RFQ' + (project.quote_number || (project.source_quote && project.source_quote.quote_number) || project.job_number || '');
}

const sqDay = (iso) => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
const sqDate = (d) => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

async function sqPost(fn, body, fallbackError) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch(`/.netlify/functions/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({ ok: false, error: 'Unexpected reply from the server' }));
  if (!res.ok || !out.ok) throw new Error(out.error || fallbackError);
  return out;
}

async function mountSupplierQuotes(ctx) {
  const { el, project } = ctx;
  const rfq = rfqNumber(project);

  async function load() {
    const [{ data: requests, error: rErr }, { data: quotes, error: qErr }] = await Promise.all([
      supabaseClient.from('supplier_quote_requests').select('*, suppliers(name, contact_email)').eq('project_id', project.id).order('created_at'),
      supabaseClient.from('supplier_quotes').select('*, suppliers(name), supplier_quote_lines(*), purchase_orders!po_id(po_number)').eq('project_id', project.id).order('created_at', { ascending: false }),
    ]);
    if (rErr) throw rErr;
    if (qErr) throw qErr;
    (quotes || []).forEach(q => q.supplier_quote_lines.sort((a, b) => a.sort_order - b.sort_order));
    return { requests: requests || [], quotes: quotes || [] };
  }

  function requestRow(r) {
    const name = escapeHtml(r.suppliers?.name || r.supplier_name || 'Supplier');
    const n = (r.lines || []).length, f = (r.attachments || []).length;
    const state = r.status === 'sent'
      ? `<span class="subtitle">Sent ${escapeHtml(sqDay(r.sent_at))}${r.sent_to ? ' to ' + escapeHtml(r.sent_to) : ''}</span>`
      : `<span class="badge amber">Not sent yet</span>`;
    return `
      <div class="sq-row" data-id="${r.id}" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:7px 0; border-bottom:1px solid var(--border);">
        <div style="flex:1 1 180px; min-width:0;"><strong>${name}</strong> <span class="subtitle">${[n ? `${n} line${n === 1 ? '' : 's'}` : '', f ? `${f} file${f === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}</span><br>${state}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="secondary btn-sm sq-lines">Details</button>
          ${r.status === 'sent' ? '<button type="button" class="secondary btn-sm sq-send">Send again</button>' : '<button type="button" class="btn-sm sq-send">Send</button><button type="button" class="secondary btn-sm sq-remove">Remove</button>'}
        </div>
      </div>`;
  }

  function quoteRow(q) {
    const name = escapeHtml(q.suppliers?.name || 'Supplier');
    const their = [q.supplier_quote_number ? 'their quote ' + escapeHtml(q.supplier_quote_number) : '', q.quoted_on ? sqDate(q.quoted_on) : ''].filter(Boolean).join(', ');
    const lines = q.supplier_quote_lines || [];
    const chip = q.status === 'approved' ? `<span class="badge accepted">Approved: ${q.purchase_orders?.po_number ? `<a href="/purchase-order.html?id=${q.po_id}" style="color:inherit;">${escapeHtml(q.purchase_orders.po_number)}</a>` : 'PO'}</span>`
      : q.status === 'denied' ? '<span class="badge draft">Denied</span>'
      : q.status === 'reading' ? '<span class="badge draft">Reading the quote...</span>'
      : '<span class="badge info">Quote in</span>';
    const total = q.total != null ? `<strong>${money(q.total)}</strong> <span class="subtitle">ex GST</span>` : (q.status === 'reading' ? '' : '<span class="subtitle">No total read</span>');
    const linesHtml = lines.length ? `<table style="width:100%; font-size:12px; margin-top:6px;"><thead><tr><th>Item</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Each</th></tr></thead><tbody>${lines.map(l => `
        <tr><td>${escapeHtml(l.description)}${l.part_number ? ` <span class="subtitle">${escapeHtml(l.part_number)}</span>` : ''}</td><td style="text-align:right;">${escapeHtml(poQty(l.quantity))}${l.unit ? ' ' + escapeHtml(l.unit) : ''}</td><td style="text-align:right;">${l.unit_cost != null ? money(l.unit_cost) : ''}</td></tr>`).join('')}</tbody></table>`
      : (q.status === 'reading' ? '' : `<p class="subtitle" style="margin:6px 0 0; font-size:12px;">${q.read_error ? escapeHtml(q.read_error) + ' ' : 'No lines were read from the file. '}Approve still makes the PO (an open PO, so the bill fills in the lines).</p>`);
    return `
      <div class="sq-quote" data-id="${q.id}" style="padding:8px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <div style="flex:1 1 180px; min-width:0;"><strong>${name}</strong> ${chip}<br><span class="subtitle">${their || 'Filed ' + escapeHtml(sqDay(q.created_at))}</span></div>
          <div style="flex:0 0 auto;">${total}</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${q.file_path ? '<button type="button" class="secondary btn-sm sq-view">View</button>' : ''}
            ${q.status === 'quoted' ? '<button type="button" class="btn-sm sq-approve">Approve</button><button type="button" class="secondary btn-sm sq-deny">Deny</button>' : ''}
            ${q.status === 'quoted' && q.read_error ? '<button type="button" class="secondary btn-sm sq-reread">Read again</button>' : ''}
          </div>
        </div>
        ${lines.length ? `<details style="margin-top:4px;"><summary class="subtitle" style="cursor:pointer; font-size:12px;">${lines.length} line${lines.length === 1 ? '' : 's'}</summary>${linesHtml}</details>` : linesHtml}
      </div>`;
  }

  async function render() {
    let data;
    try { data = await load(); } catch (err) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
    const { requests, quotes } = data;
    const waiting = requests.filter(r => r.status === 'sent' && !quotes.some(q => q.request_id === r.id)).length;
    el.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap:16px; align-items:start;">
        <div class="card" style="margin:0;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <h2 style="margin:0; flex:1;">${escapeHtml(rfq)}: suppliers asked</h2>
            <button type="button" id="sq-ask" class="btn-sm">Ask suppliers for prices</button>
          </div>
          <p class="subtitle" style="margin:0 0 8px; font-size:12px;">One request number for this ${project.job_number ? 'job' : 'quote'}, the same for every supplier. A request is for pricing, not an order: the PO comes when a quote is approved.</p>
          <div id="sq-requests">${requests.length ? requests.map(requestRow).join('') : '<p class="subtitle">Nobody asked yet.</p>'}</div>
        </div>
        <div class="card" style="margin:0;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <h2 style="margin:0; flex:1;">Quotes in</h2>
            <button type="button" id="sq-attach" class="secondary btn-sm">Attach a supplier's quote</button>
          </div>
          <p class="subtitle" style="margin:0 0 8px; font-size:12px;">A supplier's reply to ${escapeHtml(rfq)} with their quote lands here by itself, read by Tally. Approve makes the PO for that supplier${waiting ? `; ${waiting} still to reply` : ''}.</p>
          <div id="sq-quotes">${quotes.length ? quotes.map(quoteRow).join('') : '<p class="subtitle">Nothing back yet.</p>'}</div>
        </div>
      </div>
      <div id="sq-msg" style="margin-top:8px;"></div>`;

    el.querySelector('#sq-ask').addEventListener('click', () => openAskPanel(requests));
    el.querySelector('#sq-attach').addEventListener('click', () => openAttachPanel(requests));
    el.querySelectorAll('.sq-row').forEach(row => {
      const r = requests.find(x => x.id === row.dataset.id);
      row.querySelector('.sq-lines').addEventListener('click', () => showLines(r));
      row.querySelector('.sq-send').addEventListener('click', (e) => sendRequests([r], e.currentTarget));
      const rm = row.querySelector('.sq-remove');
      if (rm) rm.addEventListener('click', () => removeRequest(r));
    });
    el.querySelectorAll('.sq-quote').forEach(row => {
      const q = quotes.find(x => x.id === row.dataset.id);
      const on = (sel, fn) => { const b = row.querySelector(sel); if (b) b.addEventListener('click', (e) => fn(q, e.currentTarget)); };
      on('.sq-view', (x) => openSignedDocInNewTab(x.file_path));
      on('.sq-approve', approveQuote);
      on('.sq-deny', denyQuote);
      on('.sq-reread', rereadQuote);
    });
    if (quotes.some(q => q.status === 'reading')) setTimeout(() => { if (document.body.contains(el)) render(); }, 15000);
  }

  // ---------- the lines from the quote ----------

  // The quote's material lines, each matched to a Stock item where the name is close enough (the
  // same bar as Suggest POs), lines with the same item or wording added together.
  function quotedLines(materials) {
    const out = [];
    (ctx.centres || []).forEach(c => (c.cost_centre_line_items || []).filter(li => li.item_type === 'material').forEach(li => {
      let best = null, bestScore = 0;
      (materials || []).forEach(m => { const s = fuzzyMatchScore(m.name, li.description); if (s > bestScore) { bestScore = s; best = m; } });
      const matched = bestScore >= SQ_MATCH_SCORE ? best : null;
      const key = matched ? 'm:' + matched.id : 'd:' + String(li.description || '').trim().toLowerCase();
      const qty = Number(li.quantity) || 0;
      const have = out.find(x => x.key === key);
      if (have) { have.quantity += qty; return; }
      out.push({ key, material_id: matched ? matched.id : null, description: String(li.description || '').trim(), quantity: qty,
        unit: matched && matched.kind === 'cable' ? (matched.pack_unit || 'm') : null, part_number: matched ? matched.part_number || null : null });
    }));
    return out;
  }

  // ---------- Ask suppliers for prices ----------

  async function openAskPanel(requests) {
    const [{ data: suppliers }, { data: materials }] = await Promise.all([
      supabaseClient.from('suppliers').select('id, name, contact_email').order('name'),
      supabaseClient.from('materials').select('id, name, kind, pack_unit, part_number'),
    ]);
    let lines = quotedLines(materials);
    const chips = []; // { id, name, email }
    const pickerIds = { search: 'sq-sup-search', results: 'sq-sup-results', selected: 'sq-sup-selected', newSection: 'sq-sup-new', newEmail: 'sq-sup-new-email', newPhone: 'sq-sup-new-phone' };
    const overlay = openModal(`
      <h2 style="margin-top:0;">${escapeHtml(rfq)}: ask suppliers for prices</h2>
      <p class="subtitle" style="margin:0 0 8px; font-size:12px;">Each supplier gets the same list as a request for quote PDF, and any plans attached, in an email from the job. Not an order.</p>
      <label style="margin-top:0;">Suppliers to ask</label>
      <div id="sq-chips" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;"></div>
      <div id="sq-picker">${supplierPickerHtml(pickerIds)}</div>
      <button type="button" class="secondary btn-sm" id="sq-add-sup" style="margin-top:6px;">+ Add this supplier</button>
      <label style="margin-top:14px;">Plans and documents (optional)</label>
      <p class="subtitle" style="margin:0 0 6px; font-size:12px;">A builder's plan to quote from: attach it here and it goes to every supplier. Then the items below are optional.</p>
      <div id="sq-files"></div>
      <label style="margin-top:14px;">Items to price</label>
      <div id="sq-lines"></div>
      <button type="button" class="secondary btn-sm" id="sq-add-line" style="margin-top:6px;">+ Add line</button>
      <label>Note to the suppliers (optional)</label>
      <textarea id="sq-note" rows="2" placeholder="e.g. Delivery to site by 20 Nov, or quote the Sigenergy alternative too"></textarea>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" id="sq-send">Send the request</button>
        <button type="button" class="secondary" id="sq-cancel">Cancel</button>
      </div>
      <div id="sq-ask-msg" style="margin-top:8px;"></div>`, { maxWidth: 640, zIndex: 110 });
    const q = (s) => overlay.querySelector(s);
    let resolveSupplier = wireSupplierPicker(overlay, suppliers || [], pickerIds);
    const filePicker = emailLocalFilePicker(q('#sq-files'), { jobs: [{ id: project.id }] });

    const drawChips = () => {
      q('#sq-chips').innerHTML = chips.length ? chips.map((c, i) => `<span class="badge info" style="display:inline-flex; gap:6px; align-items:center;">${escapeHtml(c.name)}${c.email ? '' : ' <span class="subtitle">(no email saved)</span>'} <button type="button" class="sq-chip-x" data-i="${i}" style="all:unset; cursor:pointer; font-weight:700;" title="Remove">&times;</button></span>`).join('')
        : '<span class="subtitle" style="font-size:12px;">Search a supplier below and add it. Add as many as you like.</span>';
      q('#sq-chips').querySelectorAll('.sq-chip-x').forEach(b => b.addEventListener('click', () => { chips.splice(Number(b.dataset.i), 1); drawChips(); }));
    };
    const drawLines = () => {
      q('#sq-lines').innerHTML = lines.length ? `<table style="width:100%; font-size:13px;"><thead><tr><th style="width:28px;"></th><th>Item</th><th style="width:72px;">Qty</th><th style="width:60px;">Unit</th><th style="width:28px;"></th></tr></thead><tbody>${lines.map((l, i) => `
        <tr>
          <td><input type="checkbox" class="sq-l-on" data-i="${i}" ${l.off ? '' : 'checked'} style="width:auto;" /></td>
          <td><input class="sq-l-desc" data-i="${i}" value="${escapeHtml(l.description)}" style="margin:0;" />${l.material_id ? '<span class="subtitle" style="font-size:11px;">Stock item</span>' : ''}</td>
          <td><input class="sq-l-qty" data-i="${i}" type="number" step="0.01" inputmode="decimal" value="${escapeHtml(poQty(l.quantity))}" style="margin:0;" /></td>
          <td><input class="sq-l-unit" data-i="${i}" value="${escapeHtml(l.unit || '')}" placeholder="ea" style="margin:0;" /></td>
          <td><button type="button" class="sq-l-rm" data-i="${i}" style="all:unset; cursor:pointer; font-weight:700;" title="Remove">&times;</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="subtitle" style="font-size:12px;">No material lines on the quote yet. Add the items to price, or attach the plans above.</p>';
      const read = (cls, key, fn) => q('#sq-lines').querySelectorAll(cls).forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.i)][key] = fn(inp); }));
      read('.sq-l-on', 'off', (inp) => !inp.checked);
      read('.sq-l-desc', 'description', (inp) => inp.value);
      read('.sq-l-qty', 'quantity', (inp) => Number(inp.value) || 0);
      read('.sq-l-unit', 'unit', (inp) => inp.value.trim() || null);
      q('#sq-lines').querySelectorAll('.sq-l-rm').forEach(b => b.addEventListener('click', () => { lines.splice(Number(b.dataset.i), 1); drawLines(); }));
    };
    drawChips(); drawLines();

    q('#sq-add-sup').addEventListener('click', async () => {
      const msg = q('#sq-ask-msg');
      try {
        const picked = await resolveSupplier();
        if (!picked.supplierId) { msg.innerHTML = '<div class="error-box">Search a supplier first.</div>'; return; }
        if (chips.some(c => c.id === picked.supplierId)) { msg.innerHTML = ''; return; }
        let email = (suppliers || []).find(s => s.id === picked.supplierId)?.contact_email || null;
        if (!email) { const { data: fresh } = await supabaseClient.from('suppliers').select('contact_email').eq('id', picked.supplierId).maybeSingle(); email = fresh?.contact_email || null; }
        chips.push({ id: picked.supplierId, name: picked.supplierName, email });
        msg.innerHTML = '';
        drawChips();
        // a fresh picker for the next supplier
        q('#sq-picker').innerHTML = supplierPickerHtml(pickerIds);
        resolveSupplier = wireSupplierPicker(overlay, suppliers || [], pickerIds);
        q(`#${pickerIds.search}`).focus();
      } catch (err) { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; }
    });
    q('#sq-add-line').addEventListener('click', () => { lines.push({ key: 'n' + Date.now(), material_id: null, description: '', quantity: 1, unit: null }); drawLines(); q('#sq-lines').querySelector('.sq-l-desc[data-i="' + (lines.length - 1) + '"]').focus(); });
    q('#sq-cancel').addEventListener('click', () => overlay.remove());
    q('#sq-send').addEventListener('click', async () => {
      const msg = q('#sq-ask-msg'), btn = q('#sq-send');
      const sendLines = lines.filter(l => !l.off && String(l.description || '').trim()).map(l => ({ material_id: l.material_id, description: String(l.description).trim(), quantity: Number(l.quantity) || 0, unit: l.unit || null, part_number: l.part_number || null }));
      if (!chips.length) {
        // a supplier typed but not added yet counts
        try { const picked = await resolveSupplier(); if (picked.supplierId) chips.push({ id: picked.supplierId, name: picked.supplierName, email: (suppliers || []).find(s => s.id === picked.supplierId)?.contact_email || null }); } catch (e) { /* told below */ }
      }
      if (!chips.length) { msg.innerHTML = '<div class="error-box">Add at least one supplier.</div>'; return; }
      const localFiles = filePicker.files(), jobFiles = filePicker.refs();
      if (!sendLines.length && !localFiles.length && !jobFiles.length) { msg.innerHTML = '<div class="error-box">Tick at least one item to price, or attach the plans.</div>'; return; }
      if (sendLines.some(l => l.quantity <= 0)) { msg.innerHTML = '<div class="error-box">Every item needs a quantity.</div>'; return; }
      const limit = filePicker.limitError();
      if (limit) { msg.innerHTML = `<div class="error-box">${escapeHtml(limit)}</div>`; return; }
      btn.disabled = true; btn.textContent = localFiles.length ? 'Uploading...' : 'Saving...';
      try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        const note = q('#sq-note').value.trim() || null;
        // files from this computer go onto the job (Documents > Supplier quotes) first
        const uploaded = [];
        for (const f of localFiles) {
          const path = await uploadPrivateFile(f, `documents/${project.id}`);
          const { error: dErr } = await supabaseClient.from('project_documents').insert({ project_id: project.id, folder: SQ_FOLDER, file_path: path, file_name: f.name, mime_type: f.type, uploaded_by: user.id });
          if (dErr) throw dErr;
          uploaded.push({ bucket: 'project-documents', path, name: f.name, size: f.size });
        }
        const attachments = [...uploaded, ...jobFiles.map(r => ({ bucket: r.bucket, path: r.path, name: r.name, size: r.size || 0 }))];
        const { data: made, error } = await supabaseClient.from('supplier_quote_requests').insert(chips.map(c => ({
          project_id: project.id, supplier_id: c.id, supplier_name: c.name, status: 'draft', lines: sendLines, attachments, note, created_by: user.id,
        }))).select('*, suppliers(name, contact_email)');
        if (error) throw error;
        overlay.remove();
        await sendRequests(made, null);
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
        btn.disabled = false; btn.textContent = 'Send the request';
      }
    });
    setTimeout(() => q(`#${pickerIds.search}`).focus(), 30);
  }

  // The PDF (when there are lines), then the email window for each request in turn (the next opens when one is sent or
  // closed). A request whose email was not sent stays "Not sent yet" with its own Send button.
  async function sendRequests(list, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Making the PDF...'; }
    const msg = el.querySelector('#sq-msg');
    try {
      for (const r of list) {
        const sup = r.suppliers || {};
        const name = sup.name || r.supplier_name || 'the supplier';
        const hasLines = (r.lines || []).length > 0, files = r.attachments || [];
        const first = String(name).trim().split(/\s+/)[0] || 'there';
        const site = project.client_address ? ` at ${project.client_address}` : '';
        const fileName = `${rfq} ${name}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
        const attachOptions = files.map(f => ({ group: 'Plans and documents', label: f.name, bucket: f.bucket, path: f.path, name: f.name, size: f.size || 0, checked: true }));
        if (hasLines) {
          const out = await sqPost('generate-client-document-pdf', { doc_type: 'supplier_quote_request', record_id: r.id }, 'Could not make the request PDF');
          attachOptions.unshift({ group: 'Request for quote', label: fileName, bucket: 'project-documents', path: out.path, name: fileName, checked: true });
        }
        const plans = files.length === 1 ? 'plan' : 'plans';
        const ask = hasLines
          ? `Could you please price the attached list (${rfq}) for ${project.name}${site}?${files.length ? ` The ${plans} ${files.length === 1 ? 'is' : 'are'} attached too.` : ''} Please reply with your quote number, prices ex GST and availability.`
          : `Could you please quote the attached ${plans} (${rfq}) for ${project.name}${site}? Please reply with an itemised quote: your quote number, each item with its price ex GST, and availability.`;
        await new Promise((done) => openEmailComposer({
          title: `Email ${rfq} to ${name}`,
          to: sup.contact_email || '',
          subject: `${rfq} request for quote: ${project.name}`,
          body: `Hi ${first},\n\n${ask}\n\nThis is a request for pricing, not an order. A purchase order follows if we go ahead.${r.note ? '\n\n' + r.note : ''}\n\nThanks,`,
          projectId: project.id, tagKind: 'materials_quote',
          attachOptions,
          onSent: async (threadId, sent) => {
            const { error } = await supabaseClient.from('supplier_quote_requests').update({ status: 'sent', sent_at: new Date().toISOString(), email_thread_id: threadId || null, sent_to: (sent && sent.to) || null }).eq('id', r.id);
            if (error) showToast(friendlyError(error), { error: true });
            await logActivity('project', project.id, 'supplier_quote_requested', `${rfq} sent to ${name}${sent && sent.to ? ' (' + sent.to + ')' : ''}`);
            done();
          },
          onClose: done,
        }));
      }
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      render();
    }
  }

  function showLines(r) {
    const lines = r.lines || [], files = r.attachments || [];
    const overlay = openModal(`
      <h2 style="margin-top:0;">${escapeHtml(rfq)} to ${escapeHtml(r.suppliers?.name || r.supplier_name || '')}</h2>
      ${lines.length ? `<table style="width:100%; font-size:13px;"><thead><tr><th>Item</th><th style="text-align:right;">Qty</th></tr></thead><tbody>${lines.map(l => `<tr><td>${escapeHtml(l.description)}</td><td style="text-align:right;">${escapeHtml(poQty(l.quantity))}${l.unit ? ' ' + escapeHtml(l.unit) : ''}</td></tr>`).join('')}</tbody></table>` : (files.length ? '<p class="subtitle">No lines: priced from the files.</p>' : '<p class="subtitle">No lines.</p>')}
      ${files.length ? `<label style="margin-top:10px;">Files sent</label>${files.map((f, i) => `<div><a href="#" class="sq-l-file" data-i="${i}">${escapeHtml(f.name)}</a></div>`).join('')}` : ''}
      ${r.note ? `<p class="subtitle" style="margin-top:8px;">Note: ${escapeHtml(r.note)}</p>` : ''}
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        ${r.pdf_path ? '<button type="button" class="secondary" id="sq-l-pdf">View the PDF</button>' : ''}
        <button type="button" class="secondary" id="sq-l-close">Close</button>
      </div>`, { maxWidth: 520, zIndex: 110 });
    overlay.querySelector('#sq-l-close').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.sq-l-file').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); const f = files[Number(a.dataset.i)]; openSignedDocInNewTab(f.path, f.bucket); }));
    const pdf = overlay.querySelector('#sq-l-pdf');
    if (pdf) pdf.addEventListener('click', () => openSignedDocInNewTab(r.pdf_path));
  }

  async function removeRequest(r) {
    if (!confirm(`Remove the request to ${r.suppliers?.name || r.supplier_name || 'this supplier'}? It was never sent.`)) return;
    const { error } = await supabaseClient.from('supplier_quote_requests').delete().eq('id', r.id).eq('status', 'draft');
    if (error) { showToast(friendlyError(error), { error: true }); return; }
    render();
  }

  // ---------- Quotes in ----------

  async function approveQuote(q, btn) {
    const name = q.suppliers?.name || 'the supplier';
    btn.disabled = true; btn.textContent = 'Making the PO...';
    try {
      const { data, error } = await supabaseClient.rpc('supplier_quote_approve', { p_quote_id: q.id });
      if (error) throw error;
      const po = { id: data.po_id, po_number: data.po_number, supplier_id: data.supplier_id, project_id: data.project_id };
      if (ctx.onPoMade) ctx.onPoMade();
      if (data.added_to_existing) {
        const overlay = openModal(`
          <h2 style="margin-top:0;">Added to ${escapeHtml(data.po_number)}</h2>
          <p class="subtitle" style="margin-bottom:14px;">${escapeHtml(name)} already has a PO from today, so this quote's ${data.lines} line${data.lines === 1 ? '' : 's'} went on it.</p>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <button type="button" id="sq-po-email">Email the PO to the supplier again</button>
            <a class="btn secondary" href="/purchase-order.html?id=${encodeURIComponent(po.id)}" style="text-align:center;">Open the PO</a>
            <button type="button" class="secondary" id="sq-po-done">Done</button>
          </div>`, { maxWidth: 400, zIndex: 110 });
        overlay.querySelector('#sq-po-done').addEventListener('click', () => { overlay.remove(); render(); });
        overlay.querySelector('#sq-po-email').addEventListener('click', async (e) => { await emailPurchaseOrder(po, e.currentTarget); overlay.remove(); render(); });
      } else {
        showPoCreatedPanel(po, name, { onDone: render });
      }
    } catch (err) {
      showToast(friendlyError(err), { error: true });
      btn.disabled = false; btn.textContent = 'Approve';
    }
  }

  async function denyQuote(q) {
    const name = q.suppliers?.name || 'this supplier';
    if (!confirm(`Deny ${name}'s quote? No PO is made. This cannot be undone (ask them for a fresh quote instead).`)) return;
    const { data: { user } } = await supabaseClient.auth.getUser();
    const { error } = await supabaseClient.from('supplier_quotes').update({ status: 'denied', denied_at: new Date().toISOString(), denied_by: user.id }).eq('id', q.id).eq('status', 'quoted');
    if (error) { showToast(friendlyError(error), { error: true }); return; }
    await logActivity('project', project.id, 'supplier_quote_denied', `${rfq}: ${name}'s quote ${q.supplier_quote_number || ''} denied`);
    render();
  }

  async function rereadQuote(q, btn) {
    btn.disabled = true; btn.textContent = 'Reading...';
    try { await sqPost('read-supplier-quote', { quote_id: q.id }, 'Could not read the quote'); }
    catch (err) { showToast(friendlyError(err), { error: true }); }
    render();
  }

  // A quote that came another way (a PDF handed over, a different email): the file goes into
  // Documents > Supplier quotes and Tally reads it the same way.
  async function openAttachPanel(requests) {
    const asked = requests.filter((r, i, all) => all.findIndex(x => x.supplier_id === r.supplier_id) === i);
    const pickerIds = { search: 'sq-at-search', results: 'sq-at-results', selected: 'sq-at-selected', newSection: 'sq-at-new', newEmail: 'sq-at-new-email', newPhone: 'sq-at-new-phone' };
    const { data: suppliers } = await supabaseClient.from('suppliers').select('id, name').order('name');
    const overlay = openModal(`
      <h2 style="margin-top:0;">Attach a supplier's quote</h2>
      <label style="margin-top:0;">From which supplier?</label>
      ${asked.length ? `<select id="sq-at-asked">${asked.map(r => `<option value="${r.supplier_id}">${escapeHtml(r.suppliers?.name || r.supplier_name)}</option>`).join('')}<option value="">Another supplier...</option></select>` : ''}
      <div id="sq-at-picker" style="${asked.length ? 'display:none;' : ''} margin-top:6px;">${supplierPickerHtml(pickerIds)}</div>
      <label>Their quote (PDF or a photo)</label>
      <input type="file" id="sq-at-file" accept="application/pdf,image/*" />
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="sq-at-save">Attach and read it</button><button type="button" class="secondary" id="sq-at-cancel">Cancel</button></div>
      <div id="sq-at-msg" style="margin-top:8px;"></div>`, { maxWidth: 460, zIndex: 110 });
    const q = (s) => overlay.querySelector(s);
    const resolveSupplier = wireSupplierPicker(overlay, suppliers || [], pickerIds);
    const askedSel = q('#sq-at-asked');
    if (askedSel) askedSel.addEventListener('change', () => { q('#sq-at-picker').style.display = askedSel.value ? 'none' : ''; });
    q('#sq-at-cancel').addEventListener('click', () => overlay.remove());
    q('#sq-at-save').addEventListener('click', async () => {
      const msg = q('#sq-at-msg'), btn = q('#sq-at-save');
      const file = q('#sq-at-file').files[0];
      if (!file) { msg.innerHTML = '<div class="error-box">Pick the file.</div>'; return; }
      btn.disabled = true; btn.textContent = 'Uploading...';
      try {
        let supplierId = askedSel && askedSel.value ? askedSel.value : null;
        if (!supplierId) { const picked = await resolveSupplier(); supplierId = picked.supplierId; }
        if (!supplierId) throw new Error('Pick the supplier.');
        const { data: { user } } = await supabaseClient.auth.getUser();
        const path = await uploadPrivateFile(file, `documents/${project.id}`);
        const { data: doc, error: dErr } = await supabaseClient.from('project_documents').insert({ project_id: project.id, folder: SQ_FOLDER, file_path: path, file_name: file.name, mime_type: file.type, uploaded_by: user.id }).select('id').single();
        if (dErr) throw dErr;
        const request = requests.find(r => r.supplier_id === supplierId) || null;
        const { data: made, error } = await supabaseClient.from('supplier_quotes').insert({
          project_id: project.id, supplier_id: supplierId, request_id: request ? request.id : null, document_id: doc.id,
          file_path: path, file_name: file.name, mime_type: file.type, status: 'reading', created_by: user.id,
        }).select('id').single();
        if (error) throw error;
        overlay.remove();
        render();
        btn.textContent = 'Reading...';
        try { await sqPost('read-supplier-quote', { quote_id: made.id }, 'Could not read the quote'); }
        catch (err) { showToast(friendlyError(err), { error: true }); }
        render();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
        btn.disabled = false; btn.textContent = 'Attach and read it';
      }
    });
  }

  await render();
}
