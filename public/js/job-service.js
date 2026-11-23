// The card on a disconnect and reconnect job's Summary (backlog item 109), under Job type: the
// roofer's booking answers, the two sheets, what the job comes to from the price list, and the
// price email to check and send after the disconnect. Loaded on demand by js/job-type.js. Reads and
// writes through service-job.js; prices only come back for pricing roles, so the crew see the sheet
// links and the booking answers only.
// Needs supabase-client.js (supabaseClient, escapeHtml, money, friendlyError, showToast, openModal).

async function renderJobService(project, el, pricing) {
  if (!el) return;
  const api = async (action, body) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/service-job', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action, projectId: project.id, ...body }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || 'That did not work. Try again.');
    return out;
  };
  let d;
  try { d = await api('sheet', {}); } catch (err) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
  const when = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });
  const sheetLine = (kind, label) => {
    const done = (d.state[kind] || {}).finished_at;
    return `<a href="/job-sheet.html?project=${escapeHtml(project.id)}&kind=${kind}">${label} sheet</a> <span class="subtitle">${done ? `finished ${escapeHtml(when(done))}` : 'not done yet'}</span>`;
  };
  const disconnected = !!(d.state.disconnect || {}).finished_at;
  el.innerHTML = `
    <div style="font-size:13px; display:grid; gap:6px;">
      <div>${sheetLine('disconnect', 'Disconnect')} &middot; ${sheetLine('reconnect', 'Reconnect')}</div>
      ${disconnected && d.missing.length ? `<div class="error-box" style="margin:0;">Photos not taken: ${d.missing.map(escapeHtml).join(', ')}</div>` : ''}
      <div><span class="subtitle">Booking questions:</span> ${d.booking.length
        ? d.booking.map((b) => `${escapeHtml(b.label)} <strong>${escapeHtml(b.value)}</strong>`).join(' &middot; ')
        : 'not answered yet'}
        ${pricing ? ` <button type="button" class="secondary" id="js-questions" style="font-size:12px; padding:3px 8px;">${d.booked ? 'Email the questions again' : 'Email the questions'}</button>
        ${d.bookingUrl ? `<button type="button" class="secondary" id="js-copy" style="font-size:12px; padding:3px 8px;">Copy the link</button>` : ''}` : ''}</div>
      ${pricing ? `
      ${d.lines.length ? `<table style="font-size:13px; margin:2px 0;">
        <tbody>${d.lines.map((l) => `<tr><td>${escapeHtml(l.description)}</td><td class="num">${l.quantity} x ${money(l.unitPrice)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
        <tr><td><strong>From the price list, ex GST</strong></td><td></td><td class="num"><strong>${money(d.total)}</strong></td></tr></tbody>
      </table>` : '<div class="subtitle">Nothing counted yet. The price shows here once the crew fill in the disconnect sheet.</div>'}
      ${disconnected ? `<div>${d.state.price_sent_at ? `<span class="subtitle">Price emailed to the client ${escapeHtml(when(d.state.price_sent_at))}.</span> ` : ''}<button type="button" id="js-price" ${d.state.price_sent_at ? 'class="secondary"' : ''} style="font-size:13px;">${d.state.price_sent_at ? 'Send the price again' : 'Check and send price'}</button></div>` : ''}
      ${d.state.upgrade_quote_id ? `<div><a href="/project.html?id=${escapeHtml(d.state.upgrade_quote_id)}&tab=quote">The quote for a new system</a> <span class="subtitle">was started from the disconnect sheet.</span></div>` : ''}` : ''}
    </div>`;

  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
  on('#js-copy', async () => { await navigator.clipboard.writeText(d.bookingUrl); showToast('Link copied'); });
  on('#js-questions', async (e) => {
    e.target.disabled = true;
    try { await api('send-questions', {}); showToast(`Booking questions emailed to ${d.clientEmail}`); }
    catch (err) { showToast(friendlyError(err), { error: true }); }
    e.target.disabled = false;
  });
  on('#js-price', async () => {
    let draft;
    try { draft = await api('price-email', {}); } catch (err) { showToast(friendlyError(err), { error: true }); return; }
    const overlay = openModal(`
      <h2>Check and send price</h2>
      <p class="subtitle">Goes to the client from sales@ with your signature, and is kept on the job's Emails.</p>
      <label>To</label><input id="jp-to" type="email" value="${escapeHtml(draft.to || '')}" />
      <label>Subject</label><input id="jp-subject" value="${escapeHtml(draft.subject)}" />
      <label>Email</label><textarea id="jp-body" rows="12">${escapeHtml(draft.bodyText)}</textarea>
      <div id="jp-msg"></div>
      <div style="margin-top:12px;"><button type="button" id="jp-send">Send</button> <button type="button" class="secondary" id="jp-cancel">Cancel</button></div>`, { maxWidth: 620 });
    overlay.querySelector('#jp-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#jp-send').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('send-price', { to: overlay.querySelector('#jp-to').value, subject: overlay.querySelector('#jp-subject').value, bodyText: overlay.querySelector('#jp-body').value });
        overlay.remove();
        showToast('Price sent');
        renderJobService(project, el, pricing);
      } catch (err) {
        overlay.querySelector('#jp-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
        e.target.disabled = false;
      }
    });
  });
}
