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
    <div id="cp-msg"></div>`;
  loadPortalUsage(client.id, el.querySelector('#cp-usage'));
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
