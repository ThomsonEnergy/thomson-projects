// The client portal card on the Clients page (backlog item 74): who can log in (the client's own
// email plus every contact with the Portal tick), when they were last in, what they have done in
// the portal (portal_events, last 30 days, with Show more), "Send login" (portal-invite.js emails
// a temporary password to anyone who can log in and has not chosen their own password), and "Portal off" for a
// client in dispute (a reason; every session of theirs ends at once because the server checks
// portal_off_at on every call) with "Portal on" to let them back. sendPortalLogins(emails) is also
// what the save button calls for contacts newly ticked. Writes clients.portal_off_at and
// portal_off_reason and the activity log. Needs supabase-client.js (supabaseClient, escapeHtml,
// showToast, friendlyError, logActivity). Pricing roles (the page is pricing-only).

const PORTAL_EVENT_WORDS = {
  login_password: 'logged in', login_code: 'logged in with a code', set_password: 'set a password', logout: 'logged out', logout_all: 'logged out everywhere',
  viewed_list: 'looked at their jobs', viewed_job: 'looked at', opened_quote: 'opened the quote on', opened_invoice: 'opened', opened_document: 'opened', opened_variation: 'opened', opened_rates: 'opened the Schedule of Rates',
};

const portalDateText = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
const portalWhenText = (iso) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Australia/Sydney' });

// portal-invite.js with the staff member's token: { ok, sent, message } or { ok: false, error }
async function portalInvite(email, resend) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Your login has run out. Log in again and try once more.');
  const res = await fetch('/.netlify/functions/portal-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ email, resend: !!resend }),
  });
  return res.json().catch(() => ({ ok: false, error: 'No answer from the server.' }));
}

// Sends each email its login and sums up: { sent: [email], skipped: [{ email, message }] (nothing
// to send, the message says why), failed: [{ email, message }], text } where text is the one plain
// line for a toast or a box. The Clients page (save and the card) and the job's Contacts card call it.
async function sendPortalLogins(emails, { resend } = {}) {
  const sent = [], skipped = [], failed = [];
  for (const email of [...new Set(emails.filter(Boolean))]) {
    try {
      const data = await portalInvite(email, resend);
      if (!data.ok) failed.push({ email, message: data.error || 'Not sent.' });
      else if (data.sent) sent.push(email);
      else skipped.push({ email, message: data.message || 'Nothing to send.' });
    } catch (err) { failed.push({ email, message: err.message }); }
  }
  const text = [
    sent.length ? `Portal login emailed to ${sent.join(', ')}.` : '',
    ...skipped.map((s) => `${s.email}: ${s.message}`),
    ...failed.map((f) => `Not sent to ${f.email}: ${f.message}`),
  ].filter(Boolean).join(' ');
  return { sent, skipped, failed, text };
}

function renderClientPortal(client, { reopen } = {}) {
  const el = document.getElementById('client-portal');
  if (!el) return;
  const logins = [client.email, ...(client.client_contacts || []).filter((c) => c.portal_access && c.email).map((c) => c.email)].filter(Boolean);
  const off = !!client.portal_off_at;
  el.innerHTML = `
    <label>Client portal</label>
    <p class="subtitle" style="margin:0 0 6px; font-size:12px;">
      ${off ? `Portal off since ${portalDateText(client.portal_off_at)}${client.portal_off_reason ? ` (${escapeHtml(client.portal_off_reason)})` : ''}.`
        : client.portal_last_login_at ? `Last in the portal ${portalDateText(client.portal_last_login_at)}.` : 'Never logged in.'}
      ${logins.length ? ` Can log in: ${escapeHtml(logins.join(', '))}.` : ' Nobody can log in yet: add the client\'s email or tick Portal on a contact.'}
    </p>
    <div id="cp-usage" class="subtitle" style="margin:0 0 8px; font-size:12px;">Loading what they have done...</div>
    <button type="button" class="secondary" id="cp-send" style="font-size:12px; padding:6px 12px;" ${logins.length && !off ? '' : 'disabled'}>Send login</button>
    <button type="button" class="secondary" id="cp-toggle" style="font-size:12px; padding:6px 12px;">${off ? 'Portal on' : 'Portal off'}</button>
    <a class="link-quiet" href="/portal.html" target="_blank" rel="noopener" style="font-size:12px; margin-left:8px;">Open the portal</a>
    <div id="cp-msg"></div>
    <div id="cp-referral" style="margin-top:12px;"></div>`;
  loadPortalUsage(client.id, el.querySelector('#cp-usage'));
  renderClientReferral(client, el.querySelector('#cp-referral'));
  el.querySelector('#cp-send').addEventListener('click', async () => {
    const btn = el.querySelector('#cp-send');
    btn.disabled = true; btn.textContent = 'Sending...';
    const r = await sendPortalLogins(logins, { resend: true });
    btn.disabled = false; btn.textContent = 'Send login';
    el.querySelector('#cp-msg').innerHTML = `<div class="${r.failed.length ? 'error-box' : r.sent.length ? 'success-box' : 'subtitle'}">${escapeHtml(r.text)}</div>`;
  });
  el.querySelector('#cp-toggle').addEventListener('click', async () => {
    let fields;
    if (off) fields = { portal_off_at: null, portal_off_reason: null };
    else {
      const reason = prompt('Why is the portal being turned off for this client? (shown on this card only)');
      if (reason === null) return;
      fields = { portal_off_at: new Date().toISOString(), portal_off_reason: reason.trim() || null };
    }
    const { error } = await supabaseClient.from('clients').update(fields).eq('id', client.id);
    if (error) { el.querySelector('#cp-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }
    logActivity('client', client.id, off ? 'portal_on' : 'portal_off', off ? 'Client portal turned back on' : `Client portal turned off${fields.portal_off_reason ? `: ${fields.portal_off_reason}` : ''}`).catch(() => {});
    showToast(off ? 'Portal on.' : 'Portal off. Their logins end now.');
    if (reopen) reopen();
  });
}

// What this client has done in the portal: a one-line summary of the last 30 days, Show more for the list.
async function loadPortalUsage(clientId, el) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseClient.from('portal_events').select('email, action, detail, created_at').eq('client_id', clientId).gte('created_at', since).order('created_at', { ascending: false }).limit(200);
  if (error) { el.textContent = ''; return; }
  const events = data || [];
  if (!events.length) { el.textContent = 'Nothing in the portal in the last 30 days.'; return; }
  const logins = events.filter((e) => e.action.startsWith('login_'));
  const people = new Set(events.map((e) => e.email));
  const looked = [...new Set(events.filter((e) => e.action !== 'viewed_list' && !e.action.startsWith('login_') && !e.action.startsWith('logout') && e.detail).map((e) => e.detail))].slice(0, 4);
  const line = (e) => `${portalWhenText(e.created_at)}: ${escapeHtml(e.email)} ${escapeHtml(PORTAL_EVENT_WORDS[e.action] || e.action)}${e.detail ? ` ${escapeHtml(e.detail)}` : ''}`;
  el.innerHTML = `Last 30 days: ${logins.length} login${logins.length === 1 ? '' : 's'}, ${people.size} ${people.size === 1 ? 'person' : 'people'}${looked.length ? `. Looked at ${escapeHtml(looked.join(', '))}` : ''}.
    <details style="margin-top:4px;"><summary style="cursor:pointer;">Show more (${events.length})</summary><div style="margin-top:4px; max-height:220px; overflow:auto;">${events.map((e) => `<div>${line(e)}</div>`).join('')}</div></details>`;
}

// The lead reward and referral link (item 74b, step 3a): Off or On (a credit off our work, never a
// payout: owner, 20 Nov 2026); turning it on emails the
// client their link by itself. Copy, Send link and Regenerate (the old link stops working).
async function clientReferralCall(body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/client-referral', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}
function renderClientReferral(client, el) {
  if (!el) return;
  const kind = client.lead_reward_kind || 'off';
  const link = client.referral_token ? `${location.origin}/refer.html?r=${client.referral_token}` : '';
  el.innerHTML = `
    <label>Lead reward</label>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <select id="cr-kind" style="width:auto;">
        <option value="off" ${kind === 'off' ? 'selected' : ''}>Off</option>
        <option value="credit" ${kind !== 'off' ? 'selected' : ''}>On: a credit off their next invoice</option>
      </select>
      <span class="subtitle" style="font-size:12px;">Amounts are in Settings &gt; Rewards. Turning it on emails them their link.</span>
    </div>
    ${link ? `<p class="subtitle" style="margin:6px 0; font-size:12px; word-break:break-all;">Their link: <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a></p>
    <button type="button" class="secondary" id="cr-copy" style="font-size:12px; padding:6px 12px;">Copy link</button>
    <button type="button" class="secondary" id="cr-send" style="font-size:12px; padding:6px 12px;">Send link</button>
    <button type="button" class="secondary" id="cr-regen" style="font-size:12px; padding:6px 12px;">Regenerate</button>` : ''}
    <div id="cr-msg"></div>
    <div id="cr-rewards" style="margin-top:10px;"></div>`;
  const msg = (html) => { el.querySelector('#cr-msg').innerHTML = html; };
  renderLeadRewards(client, el.querySelector('#cr-rewards'));
  el.querySelector('#cr-kind').addEventListener('change', async (e) => {
    try {
      const out = await clientReferralCall({ action: 'set_kind', clientId: client.id, kind: e.target.value });
      client.lead_reward_kind = e.target.value;
      msg(out.warning ? `<div class="error-box">${escapeHtml(out.warning)}</div>` : `<div class="success-box">${out.emailed ? 'Saved, and their link has been emailed to them.' : 'Saved.'}</div>`);
    } catch (err) { msg(`<div class="error-box">${escapeHtml(err.message)}</div>`); e.target.value = kind; }
  });
  const copy = el.querySelector('#cr-copy');
  if (copy) copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); showToast('Link copied.'); } catch { prompt('Copy the link:', link); } });
  const send = el.querySelector('#cr-send');
  if (send) send.addEventListener('click', async () => {
    send.disabled = true;
    try { await clientReferralCall({ action: 'send', clientId: client.id }); msg('<div class="success-box">Link emailed.</div>'); } catch (err) { msg(`<div class="error-box">${escapeHtml(err.message)}</div>`); }
    send.disabled = false;
  });
  const regen = el.querySelector('#cr-regen');
  if (regen) regen.addEventListener('click', async () => {
    if (!confirm('Make a new link? The old one stops working straight away.')) return;
    try { const out = await clientReferralCall({ action: 'regenerate', clientId: client.id }); client.referral_token = out.token; renderClientReferral(client, el); showToast('New link made. Send it to them.'); } catch (err) { msg(`<div class="error-box">${escapeHtml(err.message)}</div>`); }
  });
}

// The client's lead rewards (item 74b step 3b): owed first, then earned (waiting on the deposit), then
// used and cancelled. A reward is a credit off our work and happens by itself: the credit note in Xero,
// the line on an invoice, the allocation (lead-rewards-background.js). A person only cancels one (why),
// or presses Try Xero again after fixing what Xero refused. Both go through lead-reward.js.
async function leadRewardCall(body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/lead-reward', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}
async function renderLeadRewards(client, el) {
  if (!el) return;
  const [{ data, error }, { data: account }] = await Promise.all([
    supabaseClient.from('lead_rewards')
      .select('id, amount, referral_kind, status, quote_total, earned_at, settled_how, settled_reference, cancelled_reason, applied_invoice_id, xero_credit_note_id, xero_credit_note_number, xero_allocated_invoice_id, xero_error, projects(job_number, name)')
      .eq('referrer_client_id', client.id).order('earned_at', { ascending: false }),
    supabaseClient.from('xero_account_mapping').select('xero_account_code').eq('category', 'lead_reward').maybeSingle(),
  ]);
  if (error) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }
  const rows = data || [];
  if (!rows.length) { el.innerHTML = ''; return; }
  const order = { due: 0, earned: 1, settled: 2, cancelled: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status]);
  const hasAccount = !!String((account && account.xero_account_code) || '').trim();
  const money = (n) => `$${Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const note = (r) => (r.xero_credit_note_number ? ` (${escapeHtml(r.xero_credit_note_number)})` : '');
  const word = (r) => {
    if (r.status === 'earned') return '<span class="badge draft">Earned, a credit once the deposit is paid</span>';
    if (r.status === 'cancelled') return `<span class="badge draft">Cancelled: ${escapeHtml(r.cancelled_reason || '')}</span>`;
    if (r.status === 'settled') {
      if (r.settled_how === 'paid') return `<span class="badge accepted">${escapeHtml(r.settled_reference || 'Refunded in Xero')}</span>`;
      const inXero = r.xero_allocated_invoice_id ? '' : r.applied_invoice_id ? ', goes to Xero when that invoice is pushed' : '';
      return `<span class="badge accepted">Credited on ${escapeHtml(r.settled_reference || 'an invoice')}${note(r)}</span>${inXero ? `<span class="subtitle" style="font-size:12px;">${inXero}</span>` : ''}`;
    }
    if (!hasAccount) return '<span class="badge sent">Owed</span> <span class="subtitle" style="font-size:12px;">waiting on the Lead rewards account in <a href="/settings.html">Settings &gt; Xero Mapping</a></span>';
    if (!r.xero_credit_note_id) return '<span class="badge sent">Owed, going to Xero</span>';
    return `<span class="badge sent">Credit waiting${note(r)}</span> <span class="subtitle" style="font-size:12px;">comes off their next invoice by itself</span>`;
  };
  const stuck = hasAccount && rows.some((r) => r.xero_error && ['due', 'settled'].includes(r.status));
  el.innerHTML = `
    <label>Lead rewards</label>
    ${rows.map((r) => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:4px 0; border-bottom:1px solid var(--border); font-size:13px;">
        <span><strong>${money(r.amount)}</strong> for ${r.projects ? `J${escapeHtml(r.projects.job_number)} ${escapeHtml(r.projects.name || '')}` : 'a job'} <span class="subtitle" style="font-size:12px;">(${escapeHtml(r.referral_kind)}, job ${money(r.quote_total)})</span> ${word(r)}
          ${r.xero_error && ['due', 'settled'].includes(r.status) ? `<div style="color:var(--red); font-size:12px;">Xero: ${escapeHtml(r.xero_error)}</div>` : ''}</span>
        ${['due', 'earned'].includes(r.status) ? `<button type="button" class="secondary lr-cancel" data-id="${r.id}" style="font-size:12px; padding:4px 10px;">Cancel</button>` : ''}
      </div>`).join('')}
    ${stuck ? '<button type="button" class="secondary" id="lr-retry" style="font-size:12px; padding:4px 10px; margin-top:6px;">Try Xero again</button>' : ''}
    <div id="lr-msg"></div>`;
  const msg = (html) => { el.querySelector('#lr-msg').innerHTML = html; };
  el.querySelectorAll('.lr-cancel').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Why is it cancelled? (shown on this card)');
    if (reason === null) return;
    b.disabled = true;
    try { await leadRewardCall({ action: 'cancel', rewardId: b.dataset.id, reason }); showToast('Cancelled.'); renderLeadRewards(client, el); }
    catch (err) { msg(`<div class="error-box">${escapeHtml(err.message)}</div>`); b.disabled = false; }
  }));
  const retry = el.querySelector('#lr-retry');
  if (retry) retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { await leadRewardCall({ action: 'retry' }); showToast('Done.'); } catch (err) { showToast(err.message); }
    renderLeadRewards(client, el);
  });
}
