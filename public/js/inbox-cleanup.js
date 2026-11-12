// Clean up (Inbox > Tools): scans the whole Gmail inbox by sender and archives, marks read or
// unsubscribes a sender in one tap. Loaded by inbox.html only when Clean up is opened (it is a
// rare tool, so it is not part of the page's load). Reads mailboxes and mailbox_cleanup_senders;
// every change goes through email-actions.js (cleanup_scan, cleanup_queue, cleanup_read_older).
// Needs supabase-client.js (supabaseClient, escapeHtml). Called with the page's state and helpers.

async function renderInboxCleanup({ S, mb, act, onePane, canMirror }) {
  S.listSeq++; // a list still loading must not paint over this screen
  clearInterval(S.cleanupTimer);
  onePane(true);
  const listEl = document.getElementById('thread-list');
  const { data: m } = await supabaseClient.from('mailboxes').select('*').eq('id', mb().id).single();
  if (!canMirror(m)) {
    listEl.innerHTML = `<div style="padding:8px 4px; max-width:620px;"><h3>Clean up</h3><p>Clean up needs the newer Gmail permission. ${S.box === 'sales' ? 'An admin connects sales@ again in Settings (Google Workspace, Connect).' : 'Disconnect and connect your Gmail again.'}</p></div>`;
    return;
  }
  let html = `<div class="list-filters"><h3>Clean up ${escapeHtml(m.address)}</h3></div>`;
  if (!m.cleanup_started_at) {
    html += `<div style="max-width:620px; padding:0 4px;">
      <p>Clears out years of old email without reading it one by one. ${escapeHtml(S.assistant)} goes through <strong>everything</strong> in your Gmail inbox (however far back), groups it by who sent it, and suggests what is safe to archive, what to keep and which senders are worth a look in case something important is hiding.</p>
      <p>Then you archive, mark read or unsubscribe a whole sender in one tap. Archived email stays in Gmail under All Mail, nothing is deleted.</p>
      <p class="subtitle">The scan takes about 10 minutes for 25,000 emails and runs in the background.</p>
      <button type="button" id="scan-btn">Start the scan</button></div>`;
    listEl.innerHTML = html;
    document.getElementById('scan-btn').addEventListener('click', async () => { await act('cleanup_scan', { mailbox_id: m.id }); renderInboxCleanup({ S, mb, act, onePane, canMirror }); });
    return;
  }
  const est = Math.max(m.cleanup_estimate || 0, m.cleanup_scanned || 0);
  const scanning = !m.cleanup_done_at;
  const { data: rows } = await supabaseClient.from('mailbox_cleanup_senders').select('*').eq('mailbox_id', m.id).order('inbox_count', { ascending: false }).limit(2000);
  const all = rows || [];
  const live = all.filter(r => r.inbox_count > 0 && !r.done_action);
  const groups = {
    archive: live.filter(r => r.suggestion === 'archive'),
    look: live.filter(r => r.suggestion === 'look' || (!r.suggestion && !scanning)),
    keep: live.filter(r => r.suggestion === 'keep'),
    working: all.filter(r => r.queued_action),
    done: all.filter(r => r.done_action && !r.queued_action),
  };
  const total = (list) => list.reduce((n, r) => n + r.inbox_count, 0);
  html += `<div style="padding:0 4px 10px;">
    ${scanning ? `<p>Scanning: ${(m.cleanup_scanned || 0).toLocaleString()} of about ${est.toLocaleString()} emails in the inbox.</p><div class="progress"><div style="width:${est ? Math.min(100, Math.round((m.cleanup_scanned || 0) / est * 100)) : 0}%;"></div></div>`
      : `<p>Scanned ${(m.cleanup_scanned || 0).toLocaleString()} emails from ${all.length.toLocaleString()} senders. ${all.some(r => !r.suggestion) ? escapeHtml(S.assistant) + ' is still sorting senders...' : ''} <a href="#" id="rescan-link" style="font-size:12px;">Scan again</a></p>`}
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px;">
      <span style="font-size:13px;">Mark everything older than</span>
      <input id="older-days" type="number" min="1" value="30" style="width:80px;" />
      <span style="font-size:13px;">days as read</span>
      <button type="button" class="secondary" id="older-btn" style="font-size:12px;">${m.cleanup_read_older_days ? 'Working...' : 'Go'}</button>
    </div></div>`;
  const tab = (k, label, list) => `<button type="button" class="secondary ${S.cleanupFilter === k ? 'on' : ''}" data-cf="${k}" style="font-size:12px; padding:5px 12px; ${S.cleanupFilter === k ? 'background:var(--accent); color:var(--accent-contrast, #fff);' : ''}">${label} (${list.length}${k === 'working' || k === 'done' ? '' : ', ' + total(list).toLocaleString() + ' emails'})</button>`;
  html += `<div style="display:flex; gap:6px; flex-wrap:wrap; padding:0 4px 8px;">${tab('archive', escapeHtml(S.assistant) + ' says archive', groups.archive)}${tab('look', 'Worth a look', groups.look)}${tab('keep', 'Keep', groups.keep)}${tab('working', 'Working', groups.working)}${tab('done', 'Done', groups.done)}</div>`;
  const list = groups[S.cleanupFilter] || [];
  const actionable = ['archive', 'look', 'keep'].includes(S.cleanupFilter);
  if (actionable && list.length) {
    html += `<div style="display:flex; gap:6px; flex-wrap:wrap; padding:0 4px 8px; align-items:center;">
      <label style="margin:0; font-size:12px; font-weight:400; display:flex; align-items:center; gap:4px;"><input type="checkbox" id="cu-all" style="width:auto;" /> Select all</label>
      <button type="button" class="cu-bulk" data-q="archive" style="font-size:12px;">Archive selected</button>
      <button type="button" class="secondary cu-bulk" data-q="unsubscribe" style="font-size:12px;">Unsubscribe and archive selected</button>
      <button type="button" class="secondary cu-bulk" data-q="read" style="font-size:12px;">Mark selected read</button>
      <button type="button" class="secondary cu-bulk" data-q="keep" style="font-size:12px;">Keep selected</button></div>`;
  }
  // How Unsubscribe would work for a sender, from their List-Unsubscribe header: an email from this
  // mailbox to their address (shown, and confirmed before it is sent), or their link (S19).
  const unsubTarget = (r) => {
    const links = [...String(r.list_unsubscribe || '').matchAll(/<([^>]+)>/g)].map(x => x[1]);
    const mailto = links.find(l => /^mailto:/i.test(l));
    const https = links.find(l => /^https:\/\//i.test(l));
    if (https && r.one_click_unsubscribe) return { kind: 'one_click' };
    if (mailto) {
      try { const to = decodeURIComponent(new URL(mailto).pathname).split(/[\r\n,;\s]/)[0]; if (to) return { kind: 'email', to }; } catch (e) { /* not a usable mailto */ }
    }
    return https ? { kind: 'link' } : null;
  };
  const unsubText = (t) => !t ? '' : t.kind === 'email' ? `Unsubscribe sends an email from ${m.address} to ${t.to}` : t.kind === 'one_click' ? 'Unsubscribe uses the sender\'s one-click link' : 'Unsubscribe gives you the sender\'s link to open';
  html += `<table class="cleanup-table"><tbody>${list.slice(0, 400).map(r => {
    const link = String(r.done_action || '').startsWith('link:') ? r.done_action.slice(5) : null;
    const unsub = actionable && r.list_unsubscribe ? unsubTarget(r) : null;
    return `<tr>
      ${actionable ? `<td style="width:24px;"><input type="checkbox" class="cu-pick" data-s="${escapeHtml(r.sender)}" style="width:auto;" /></td>` : ''}
      <td><strong>${escapeHtml(r.sender_name || r.sender)}</strong><div class="subtitle" style="font-size:12px;">${escapeHtml(r.sender)}</div>
        <div class="subtitle" style="font-size:12px;">${escapeHtml((r.sample_subjects || []).join(' / ')).slice(0, 160)}</div>
        ${unsub ? `<div class="subtitle" style="font-size:12px;">${escapeHtml(unsubText(unsub))}</div>` : ''}</td>
      <td style="white-space:nowrap;">${r.inbox_count.toLocaleString()} emails<div class="subtitle" style="font-size:12px;">${r.unread_count.toLocaleString()} unread${r.latest_at ? ', last ' + new Date(r.latest_at).toLocaleDateString('en-AU') : ''}</div></td>
      <td style="font-size:12px;">${escapeHtml(r.suggestion_reason || '')}${r.queued_action ? '<div><em>Working...</em></div>' : ''}${r.done_action ? `<div>${link ? `Open the <a href="${escapeHtml(link)}" target="_blank" rel="noopener">unsubscribe page</a>, archived` : escapeHtml(r.done_action)}</div>` : ''}</td>
      ${actionable ? `<td style="white-space:nowrap;"><button type="button" class="cu-one" data-s="${escapeHtml(r.sender)}" data-q="archive">Archive all</button>${r.list_unsubscribe ? `<button type="button" class="secondary cu-one" data-s="${escapeHtml(r.sender)}" data-q="unsubscribe">Unsubscribe</button>` : ''}<button type="button" class="secondary cu-one" data-s="${escapeHtml(r.sender)}" data-q="read">Mark read</button>${S.cleanupFilter !== 'keep' ? `<button type="button" class="secondary cu-one" data-s="${escapeHtml(r.sender)}" data-q="keep">Keep</button>` : ''}</td>` : ''}
    </tr>`;
  }).join('') || `<tr><td class="subtitle">${scanning ? 'Senders show here as the scan goes.' : 'Nothing here.'}</td></tr>`}</tbody></table>`;
  listEl.innerHTML = html;

  const queue = async (senders, q) => {
    if (!senders.length) return;
    if (q === 'unsubscribe') {
      // every unsubscribe is confirmed, with the addresses the emails would go to (S19)
      const emails = senders.map(s => { const t = unsubTarget(all.find(r => r.sender === s) || {}); return t && t.kind === 'email' ? `${t.to} (for ${s})` : null; }).filter(Boolean);
      const who = senders.length === 1 ? senders[0] : `${senders.length} senders`;
      const text = emails.length
        ? `This sends an unsubscribe email from ${m.address} to:\n${emails.slice(0, 12).join('\n')}${emails.length > 12 ? `\nand ${emails.length - 12} more` : ''}\n\nThen it archives everything in the inbox from ${who}. Go ahead?`
        : `Unsubscribe (the sender's own link) and archive everything in the inbox from ${who}?`;
      if (!confirm(text)) return;
    } else if (q !== 'keep' && senders.length > 1 && !confirm(`${q === 'read' ? 'Mark as read' : 'Archive'} everything in the inbox from ${senders.length} senders?`)) return;
    try { await act('cleanup_queue', { mailbox_id: m.id, senders, queue: q }); } catch (err) { alert(err.message); return; }
    renderInboxCleanup({ S, mb, act, onePane, canMirror });
  };
  listEl.querySelectorAll('[data-cf]').forEach(b => b.addEventListener('click', () => { S.cleanupFilter = b.dataset.cf; renderInboxCleanup({ S, mb, act, onePane, canMirror }); }));
  listEl.querySelectorAll('.cu-one').forEach(b => b.addEventListener('click', () => queue([b.dataset.s], b.dataset.q)));
  listEl.querySelectorAll('.cu-bulk').forEach(b => b.addEventListener('click', () => queue([...listEl.querySelectorAll('.cu-pick:checked')].map(c => c.dataset.s), b.dataset.q)));
  const allBox = document.getElementById('cu-all');
  if (allBox) allBox.addEventListener('change', () => listEl.querySelectorAll('.cu-pick').forEach(c => { c.checked = allBox.checked; }));
  const rescan = document.getElementById('rescan-link');
  if (rescan) rescan.addEventListener('click', async (e) => { e.preventDefault(); if (!confirm('Scan the whole inbox again?')) return; await act('cleanup_scan', { mailbox_id: m.id }); renderInboxCleanup({ S, mb, act, onePane, canMirror }); });
  document.getElementById('older-btn').addEventListener('click', async () => {
    const days = parseInt(document.getElementById('older-days').value, 10) || 30;
    if (!confirm(`Mark every unread email in the inbox older than ${days} days as read? They stay in the inbox.`)) return;
    await act('cleanup_read_older', { mailbox_id: m.id, days });
    renderInboxCleanup({ S, mb, act, onePane, canMirror });
  });
  if (scanning || groups.working.length || m.cleanup_read_older_days || all.some(r => !r.suggestion)) {
    S.cleanupTimer = setInterval(() => { if (S.view === 'cleanup' && !document.querySelector('.cu-pick:checked')) renderInboxCleanup({ S, mb, act, onePane, canMirror }); }, 8000);
  }
}
