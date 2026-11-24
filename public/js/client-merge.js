// Client clean-up panels on the Clients page (backlog item 110), loaded on first use by
// js/client-cleanup.js:
//   openClientMergePanel(keep, { getClients, reload, oldId })   "Merge another client into this
//       one" (Admin): possible duplicates of this client by rule, a search for any other client,
//       See what will move (client_merge_preview), then Merge (client_merge, one step in the
//       database, all or nothing).
//   openAbnReview(ctx)         what the background ABN search found: pick, tick, Apply selected.
//   openDuplicateReview(ctx)   the pairs the duplicate scan recommends, each opening the merge panel.
// Nothing here merges or saves an ABN by itself: a person presses Merge or Apply selected.
// Needs supabase-client.js (supabaseClient, escapeHtml, friendlyError, showToast, openModal) and
// js/client-cleanup.js (clientCleanupApi).

const cmDigits = (s) => String(s || '').replace(/\D/g, '');
const cmName = (s) => String(s || '').toLowerCase().replace(/\b(pty|ltd|limited|the|trust|p\/l)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Other clients that share this one's name, email, phone or ABN, strongest reason first.
function possibleDuplicates(client, clients) {
  const mine = { name: cmName(client.name), email: String(client.email || '').trim().toLowerCase(), phone: cmDigits(client.phone).slice(-9), abn: cmDigits(client.abn) };
  return clients.filter((c) => c.id !== client.id).map((c) => {
    const why = [];
    const n = cmName(c.name);
    if (mine.abn.length === 11 && cmDigits(c.abn) === mine.abn) why.push('same ABN');
    if (mine.name && n === mine.name) why.push('same name');
    else if (mine.name.length >= 8 && n.length >= 8 && (n.startsWith(`${mine.name} `) || mine.name.startsWith(`${n} `))) why.push('similar name');
    if (mine.email && String(c.email || '').trim().toLowerCase() === mine.email) why.push('same email');
    if (mine.phone.length >= 8 && cmDigits(c.phone).slice(-9) === mine.phone) why.push('same phone');
    return { client: c, why };
  }).filter((x) => x.why.length).sort((a, b) => b.why.length - a.why.length).slice(0, 12);
}

function openClientMergePanel(keep, { getClients, reload, oldId = null }) {
  const clients = getClients();
  const overlay = openModal(`
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
      <div><h2 style="margin:0;">Merge another client into ${escapeHtml(keep.name)}</h2>
        <p class="subtitle" style="margin:4px 0 0;">${escapeHtml(keep.name)} is kept. The other client's jobs, quotes, invoices, sites, contacts and equipment move onto it, then the other record is removed. This cannot be undone with a button.</p></div>
      <button type="button" class="secondary" id="cm-close" style="font-size:12px; padding:6px 10px;">Close</button>
    </div>
    <div id="cm-pick" style="margin-top:12px;"></div>
    <div id="cm-preview" style="margin-top:12px;"></div>`, { maxWidth: 760 });
  overlay.querySelector('#cm-close').addEventListener('click', () => overlay.remove());
  const pickEl = overlay.querySelector('#cm-pick');
  const previewEl = overlay.querySelector('#cm-preview');
  const line = (c) => `${escapeHtml(c.name)} <span class="subtitle">${escapeHtml([c.email, c.phone, c.abn ? `ABN ${c.abn}` : ''].filter(Boolean).join(' · '))}</span>`;

  function drawPick(q) {
    const likely = possibleDuplicates(keep, clients);
    const text = String(q || '').trim().toLowerCase();
    const found = text.length >= 2 ? clients.filter((c) => c.id !== keep.id && [c.name, c.email, c.phone].some((v) => String(v || '').toLowerCase().includes(text))).slice(0, 10) : [];
    const row = (c, why) => `<div class="cm-row" data-id="${escapeHtml(c.id)}" style="padding:7px 10px; border-top:1px solid var(--border); cursor:pointer;">${line(c)}${why ? ` <span class="badge sent" style="font-size:10px;">${escapeHtml(why)}</span>` : ''}</div>`;
    pickEl.innerHTML = `
      <label style="margin-top:0;">Possible duplicates</label>
      <div style="border:1px solid var(--border); border-radius:8px;">${likely.length ? likely.map((x) => row(x.client, x.why.join(', '))).join('') : '<div class="subtitle" style="padding:8px 10px;">None by name, email, phone or ABN.</div>'}</div>
      <label>Or find any other client</label>
      <input id="cm-search" placeholder="Name, email or phone" value="${escapeHtml(q || '')}" autocomplete="off" />
      ${found.length ? `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">${found.map((c) => row(c, '')).join('')}</div>` : ''}`;
    const search = pickEl.querySelector('#cm-search');
    search.addEventListener('input', () => { const at = search.selectionStart; drawPick(search.value); const again = pickEl.querySelector('#cm-search'); again.focus(); again.setSelectionRange(at, at); });
    pickEl.querySelectorAll('.cm-row').forEach((el) => el.addEventListener('click', () => preview(el.dataset.id)));
  }

  async function preview(fromId) {
    previewEl.innerHTML = '<p class="subtitle">Working out what will move...</p>';
    const { data: p, error } = await supabaseClient.rpc('client_merge_preview', { p_into: keep.id, p_from: fromId });
    if (error) { previewEl.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }
    const c = p.old.counts;
    const moves = [['jobs', 'job', 'jobs'], ['quotes', 'quote', 'quotes'], ['invoices', 'invoice', 'invoices'], ['sites', 'site', 'sites'], ['contacts', 'contact', 'contacts'], ['equipment', 'piece of equipment', 'pieces of equipment'], ['emails', 'email thread', 'email threads'], ['leads_referred', 'lead referred', 'leads referred'], ['lead_rewards', 'lead reward', 'lead rewards']]
      .filter(([k]) => Number(c[k]) > 0).map(([k, one, many]) => `${c[k]} ${Number(c[k]) === 1 ? one : many}`);
    const differs = [['Payment terms', 'payment_terms'], ['Rate card', 'rate_card'], ['Commercial agreement', 'agreement'], ['Lead reward', 'lead_reward_kind'], ['ABN', 'abn'], ['Type', 'client_type']]
      .filter(([, k]) => String(p.keep[k] ?? '') !== String(p.old[k] ?? '') && (p.old[k] || p.keep[k]));
    const show = (v) => (v === true ? 'Yes' : v === false || v == null || v === '' ? 'none' : String(v).replace('_', ' '));
    previewEl.innerHTML = `
      <div class="card" style="margin:0;">
        <strong>${escapeHtml(p.old.name)}</strong> will be merged into <strong>${escapeHtml(p.keep.name)}</strong>
        <p style="margin:6px 0;">Moves across: ${moves.length ? escapeHtml(moves.join(', ')) : 'nothing (the record is empty)'}.${Number(c.unpaid_invoices) > 0 ? ` ${escapeHtml(c.unpaid_invoices)} unpaid invoice${Number(c.unpaid_invoices) === 1 ? '' : 's'} will show on ${escapeHtml(p.keep.name)}'s statement.` : ''}</p>
        ${Number(p.renamed) > 0 ? `<p class="subtitle" style="margin:6px 0;">${escapeHtml(p.renamed)} open job${Number(p.renamed) === 1 ? '' : 's'} or quote${Number(p.renamed) === 1 ? '' : 's'} with no invoice will take the name "${escapeHtml(p.keep.name)}". Anything already invoiced keeps the name it was invoiced under.</p>` : ''}
        ${differs.length ? `<table style="font-size:13px; margin:6px 0;"><thead><tr><th>They differ on</th><th>${escapeHtml(p.keep.name)} (kept)</th><th>${escapeHtml(p.old.name)} (goes)</th></tr></thead>
          <tbody>${differs.map(([label, k]) => `<tr><td>${label}</td><td><strong>${escapeHtml(show(p.keep[k]))}</strong></td><td>${escapeHtml(show(p.old[k]))}</td></tr>`).join('')}</tbody></table>
          <p class="subtitle" style="margin:0 0 6px;">The kept client's own details stay. A blank on the kept client is filled from the other.</p>` : ''}
        ${Number(p.blocked) > 0 ? `<div class="error-box">${escapeHtml(p.old.name)} has a lead reward credit in Xero that is not on an invoice yet. Let it land on an invoice, or cancel it, then merge.</div>` : `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
          <button type="button" id="cm-go">Merge into ${escapeHtml(p.keep.name)}</button>
          <button type="button" class="secondary" id="cm-swap">Keep ${escapeHtml(p.old.name)} instead</button>
        </div>`}
        <div id="cm-msg"></div>
      </div>`;
    const swap = previewEl.querySelector('#cm-swap');
    if (swap) swap.addEventListener('click', () => { overlay.remove(); const other = clients.find((x) => x.id === fromId); if (other) openClientMergePanel(other, { getClients, reload, oldId: keep.id }); });
    const go = previewEl.querySelector('#cm-go');
    if (go) go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Merging...';
      const { error: mergeErr } = await supabaseClient.rpc('client_merge', { p_into: keep.id, p_from: fromId });
      if (mergeErr) {
        previewEl.querySelector('#cm-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(mergeErr))}</div>`;
        go.disabled = false;
        go.textContent = `Merge into ${p.keep.name}`;
        return;
      }
      overlay.remove();
      showToast(`${p.old.name} merged into ${p.keep.name}`);
      reload(keep.id);
    });
  }

  drawPick('');
  if (oldId) preview(oldId);
}

async function openAbnReview({ reload, refresh }) {
  const overlay = openModal('<h2 style="margin-top:0;">ABNs to review</h2><div id="ar-body"><p class="subtitle">Loading...</p></div>', { maxWidth: 820 });
  const body = overlay.querySelector('#ar-body');
  let rows;
  try { ({ rows } = await clientCleanupApi('client-cleanup', { action: 'abns' })); } catch (err) { body.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
  const option = (r) => `ABN ${r.abn}${r.status ? ` (${r.status})` : ''}: ${r.name}${r.entityName && r.entityName !== r.name ? `, ${r.entityName}` : ''}`;
  const draw = () => {
    body.innerHTML = `
      <p class="subtitle" style="margin-top:0;">From the ABN register, for business clients with no ABN. Green is one active ABN whose name matches exactly: it is ticked, but nothing is saved until you press Apply selected.</p>
      ${rows.length ? rows.map((row, i) => {
        const chosen = row.results[row.chosen || 0] || {};
        return `<div style="padding:8px 0; border-top:1px solid var(--border); display:flex; gap:10px; align-items:flex-start;" data-i="${i}">
          <input type="checkbox" class="ar-tick" ${row.ticked ? 'checked' : ''} style="width:auto; margin-top:4px;" />
          <div style="flex:1; min-width:0;">
            <strong>${escapeHtml(row.name)}</strong> ${row.exact ? '<span class="badge accepted" style="font-size:10px;">Exact match</span>' : '<span class="badge draft" style="font-size:10px;">Check this one</span>'}
            <select class="ar-pick" style="margin-top:4px;">${row.results.map((r, ri) => `<option value="${ri}" ${ri === (row.chosen || 0) ? 'selected' : ''}>${escapeHtml(option(r))}</option>`).join('')}</select>
            ${chosen.entityName ? `<div style="font-size:12px;">${escapeHtml(chosen.entityType || 'Entity')}: ${escapeHtml(chosen.entityName)} · ${chosen.gstRegistered ? 'GST registered' : 'Not registered for GST'}${chosen.postcode ? ` · ${escapeHtml([chosen.state, chosen.postcode].filter(Boolean).join(' '))}` : ''}</div>` : ''}
            ${chosen.becomesCompany ? `<div class="subtitle" style="font-size:12px;">${row.typeHeld ? 'Stays Individual for now: it has an unpaid invoice with an STC credit, and changing the type would change that invoice. Change it by hand once the invoice is paid.' : 'Labelled Individual: will change to Company with this ABN.'}</div>` : ''}
          </div>
          <button type="button" class="secondary ar-none" style="font-size:12px; padding:4px 8px;">None of these</button>
        </div>`;
      }).join('') : '<p class="subtitle">Nothing to review. Press Find ABNs to search again.</p>'}
      <div id="ar-msg"></div>
      <div style="margin-top:12px;">${rows.length ? '<button type="button" id="ar-apply">Apply selected</button> ' : ''}<button type="button" class="secondary" id="ar-close">Close</button></div>`;
    body.querySelector('#ar-close').addEventListener('click', () => overlay.remove());
    body.querySelectorAll('[data-i]').forEach((rowEl) => {
      const row = rows[Number(rowEl.dataset.i)];
      rowEl.querySelector('.ar-tick').addEventListener('change', (e) => { row.ticked = e.target.checked; });
      rowEl.querySelector('.ar-pick').addEventListener('change', (e) => { row.chosen = Number(e.target.value); draw(); });
      rowEl.querySelector('.ar-none').addEventListener('click', async () => {
        try { await clientCleanupApi('client-cleanup', { action: 'no-abn', clientId: row.clientId }); rows = rows.filter((x) => x !== row); draw(); refresh(); }
        catch (err) { showToast(friendlyError(err), { error: true }); }
      });
    });
    const apply = body.querySelector('#ar-apply');
    if (apply) apply.addEventListener('click', async () => {
      const items = rows.filter((r) => r.ticked).map((r) => ({ clientId: r.clientId, abn: (r.results[r.chosen || 0] || {}).abn })).filter((x) => x.abn);
      if (!items.length) { body.querySelector('#ar-msg').innerHTML = '<div class="error-box">Tick at least one.</div>'; return; }
      apply.disabled = true;
      try {
        const out = await clientCleanupApi('client-cleanup', { action: 'apply-abns', items });
        overlay.remove();
        showToast(`${out.applied} ABN${out.applied === 1 ? '' : 's'} saved${out.typeChanged ? `, ${out.typeChanged} changed to Company` : ''}`);
        refresh();
        reload();
      } catch (err) { body.querySelector('#ar-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; apply.disabled = false; }
    });
  };
  rows.forEach((r) => { r.ticked = !!r.exact; r.chosen = 0; });
  draw();
}

async function openDuplicateReview({ getClients, reload, refresh }) {
  const overlay = openModal('<h2 style="margin-top:0;">Duplicates to review</h2><div id="dr-body"><p class="subtitle">Loading...</p></div>', { maxWidth: 860 });
  const body = overlay.querySelector('#dr-body');
  let rows;
  try { ({ rows } = await clientCleanupApi('client-cleanup', { action: 'duplicates' })); } catch (err) { body.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
  const facts = (c) => `${c.facts.jobs} jobs, ${c.facts.invoices} invoices, ${c.facts.sites} sites${c.facts.lastUsed ? `, last used ${new Date(c.facts.lastUsed).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}` : ', never used'}`;
  const side = (c, keep) => `<div style="flex:1; min-width:220px;"><strong>${escapeHtml(c.name)}</strong> ${keep ? '<span class="badge accepted" style="font-size:10px;">Keep</span>' : ''}<br><span class="subtitle" style="font-size:12px;">${escapeHtml([c.email, c.phone, c.abn ? `ABN ${c.abn}` : ''].filter(Boolean).join(' · ') || 'no contact details')}<br>${escapeHtml(facts(c))}</span></div>`;
  const verdictText = { same: 'Same customer', unsure: 'Not sure', apart: 'Different customers' };
  const draw = () => {
    body.innerHTML = `
      <p class="subtitle" style="margin-top:0;">Pairs that share a name, email, phone or ABN, read by the AI. It only recommends: open a pair to see what will move, then merge it yourself. "Not the same" is remembered.</p>
      ${rows.length ? rows.map((r, i) => `
        <div style="padding:10px 0; border-top:1px solid var(--border);" data-i="${i}">
          <div style="display:flex; gap:12px; flex-wrap:wrap;">${side(r.a, r.keepId === r.a.id)}${side(r.b, r.keepId === r.b.id)}</div>
          <div style="font-size:13px; margin-top:4px;"><span class="badge ${r.verdict === 'same' ? 'accepted' : 'draft'}" style="font-size:10px;">${verdictText[r.verdict]}${r.verdict === 'same' ? ` ${Math.round(r.confidence * 100)}%` : ''}</span> ${escapeHtml(r.reason || '')} <span class="subtitle">(${escapeHtml(r.why || '')})</span></div>
          <div style="margin-top:6px; display:flex; gap:8px;">
            ${r.verdict === 'apart' ? '' : '<button type="button" class="dr-merge" style="font-size:12px; padding:5px 10px;">See what will move</button>'}
            <button type="button" class="secondary dr-no" style="font-size:12px; padding:5px 10px;">Not the same</button>
          </div>
        </div>`).join('') : '<p class="subtitle">Nothing to review. Press Find duplicates to scan again.</p>'}
      <div style="margin-top:12px;"><button type="button" class="secondary" id="dr-close">Close</button></div>`;
    body.querySelector('#dr-close').addEventListener('click', () => overlay.remove());
    body.querySelectorAll('[data-i]').forEach((rowEl) => {
      const r = rows[Number(rowEl.dataset.i)];
      const merge = rowEl.querySelector('.dr-merge');
      if (merge) merge.addEventListener('click', () => {
        const keepId = r.keepId || r.a.id;
        const keep = getClients().find((c) => c.id === keepId);
        if (!keep) { showToast('That client is no longer in the list. Scan again.', { error: true }); return; }
        overlay.remove();
        openClientMergePanel(keep, { getClients, reload, oldId: keepId === r.a.id ? r.b.id : r.a.id });
      });
      rowEl.querySelector('.dr-no').addEventListener('click', async () => {
        try { await clientCleanupApi('client-cleanup', { action: 'dismiss-duplicate', id: r.id }); rows = rows.filter((x) => x !== r); draw(); refresh(); }
        catch (err) { showToast(friendlyError(err), { error: true }); }
      });
    });
  };
  draw();
}
