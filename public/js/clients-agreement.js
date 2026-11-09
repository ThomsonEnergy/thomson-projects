// The commercial agreement on a client (item 48, spec D1a), under the agreement dropdown on the
// Clients page: when it was sent or withdrawn, "Send commercial agreement" (the PDF letter and
// Schedule of Rates from generate-client-document-pdf, emailed from sales@ through the usual
// composer, js/email-compose.js downloaded on first use) and "Withdraw agreement" (one database
// step, client_withdraw_agreement: the client and all their quotes and jobs back to Standard rates).
// Writes clients.agreement_sent_at and the activity log; the rest is on the server. Needs
// supabase-client.js (supabaseClient, escapeHtml, showToast, friendlyError, logActivity) and
// rate-cards.js (loadRateCards, rateCardOf). Pricing roles (the page itself is pricing-only).

function renderClientAgreement(client, { reopen } = {}) {
  const el = document.getElementById('client-agreement');
  if (!el) return;
  if (!client) { el.innerHTML = ''; return; }
  const dateText = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
  loadRateCards().then((cards) => {
    const card = rateCardOf(client, cards);
    const off = Number(card.percent) < 100 ? Math.round((100 - Number(card.percent)) * 10) / 10 : 0;
    const lines = [];
    if (off > 0) lines.push(client.agreement_sent_at ? `Sent ${dateText(client.agreement_sent_at)}.` : 'Not sent yet.');
    else if (client.agreement_withdrawn_at) lines.push(`Withdrawn ${dateText(client.agreement_withdrawn_at)}${client.agreement_withdrawn_reason ? ` (${client.agreement_withdrawn_reason})` : ''}.`);
    el.innerHTML = `
      ${lines.length ? `<p class="subtitle" style="margin:0 0 6px; font-size:12px;">${escapeHtml(lines.join(' '))}</p>` : ''}
      ${off > 0 ? `
        <button type="button" class="secondary" id="ca-send-btn" style="font-size:12px; padding:6px 12px;">${client.agreement_sent_at ? 'Send again' : 'Send commercial agreement'}</button>
        <button type="button" class="secondary" id="ca-withdraw-btn" style="font-size:12px; padding:6px 12px;">Withdraw agreement</button>` : ''}
      <div id="ca-msg"></div>`;
    const unsaved = () => (document.getElementById('c-rate-card')?.value || '') !== (client.rate_card_id || '');
    el.querySelector('#ca-send-btn')?.addEventListener('click', () => {
      if (unsaved()) { showToast('Save the client first, then send.', { error: true }); return; }
      sendClientAgreement(client, card, off, reopen);
    });
    el.querySelector('#ca-withdraw-btn')?.addEventListener('click', () => {
      if (unsaved()) { showToast('Save the client first.', { error: true }); return; }
      withdrawClientAgreement(client, reopen);
    });
  }).catch((err) => { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; });
}

// The composer lives in js/email-compose.js, downloaded the first time it is needed so the Clients
// page stays light (the same way the job page loads its tabs).
function loadEmailComposer() {
  if (window.openEmailComposer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/email-compose.js?v=11';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the email window. Check the connection and try again.'));
    document.head.appendChild(s);
  });
}

async function sendClientAgreement(client, card, off, reopen) {
  const btn = document.getElementById('ca-send-btn');
  const msg = document.getElementById('ca-msg');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Making the PDF...'; msg.innerHTML = '';
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const [res] = await Promise.all([
      fetch('/.netlify/functions/generate-client-document-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ doc_type: 'commercial_agreement', record_id: client.id }),
      }),
      loadEmailComposer(),
    ]);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.path) throw new Error(data.error || 'The PDF could not be made.');
    const contact = (client.client_contacts || []).find((c) => c.email) || null;
    const to = client.email || contact?.email || '';
    const first = String(contact?.name || client.name || '').trim().split(/\s+/)[0] || 'there';
    openEmailComposer({
      title: 'Email the commercial agreement',
      to,
      subject: 'Commercial agreement, Thomson Energy',
      body: `Hi ${first},\n\nAttached is your commercial agreement with Thomson Energy and our current Schedule of Rates. It sets out the ${off}% efficiency reduction on labour for your do and charge work and the conditions it runs under. Nothing to sign, it is for your records.\n\nCall me with any questions.\n\nThanks,`,
      tagKind: 'client',
      attachOptions: [{ group: 'Documents', label: 'Commercial agreement and Schedule of Rates (PDF)', bucket: 'project-documents', path: data.path, name: 'Thomson Energy commercial agreement.pdf', checked: true }],
      onSent: async () => {
        const { error } = await supabaseClient.from('clients').update({ agreement_sent_at: new Date().toISOString(), agreement_withdrawn_at: null, agreement_withdrawn_reason: null }).eq('id', client.id);
        if (error) { showToast('Sent, but the sent date could not be saved: ' + error.message, { error: true }); return; }
        await logActivity('client', client.id, 'agreement_sent', `Commercial agreement ${card.name} (${off}% off labour) sent to ${to || 'the client'}`);
        showToast('Commercial agreement sent');
        if (reopen) reopen();
      },
    });
  } catch (err) {
    msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function withdrawClientAgreement(client, reopen) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:120; padding:16px;';
  const reasons = ['Invoices not paid by the due date', 'Invoices disputed', 'More quoting or admin per job', 'Our decision'];
  overlay.innerHTML = `
    <div class="card" style="max-width:440px; width:100%;">
      <h2 style="margin-top:0;">Withdraw the agreement</h2>
      <p class="subtitle" style="font-size:13px;">${escapeHtml(client.name)} and every quote and job of theirs go back to Standard rates from now on. Invoices already made are not changed; the next one has no agreement line.</p>
      <label>Reason</label>
      <select id="ca-reason">${reasons.map((r) => `<option>${escapeHtml(r)}</option>`).join('')}<option value="other">Other</option></select>
      <input id="ca-reason-other" placeholder="Say why" style="display:none; margin-top:6px;" />
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button type="button" class="danger" id="ca-withdraw-go">Withdraw</button>
        <button type="button" class="secondary" id="ca-withdraw-cancel">Cancel</button>
      </div>
      <div id="ca-withdraw-msg"></div>
    </div>`;
  document.body.appendChild(overlay);
  const sel = overlay.querySelector('#ca-reason');
  const other = overlay.querySelector('#ca-reason-other');
  sel.addEventListener('change', () => { other.style.display = sel.value === 'other' ? '' : 'none'; });
  overlay.querySelector('#ca-withdraw-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ca-withdraw-go').addEventListener('click', async () => {
    const reason = sel.value === 'other' ? other.value.trim() : sel.value;
    const go = overlay.querySelector('#ca-withdraw-go');
    go.disabled = true;
    const { data: count, error } = await supabaseClient.rpc('client_withdraw_agreement', { p_client_id: client.id, p_reason: reason });
    if (error) { overlay.querySelector('#ca-withdraw-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; go.disabled = false; return; }
    overlay.remove();
    const n = Number(count) || 0;
    showToast(`Agreement withdrawn. ${n} quote${n === 1 ? '' : 's'} and job${n === 1 ? '' : 's'} back to Standard rates.`);
    if (reopen) reopen();
  });
}
