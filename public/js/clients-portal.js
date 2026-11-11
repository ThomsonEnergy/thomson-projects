// The client portal card on the Clients page (backlog item 74): when the client was last in the
// portal, who can log in (the client's own email plus every contact with the Portal tick), and
// "Portal off" for a client in dispute (a reason; every session of theirs ends at once because the
// server checks portal_off_at on every call) with "Portal on" to let them back in. Writes
// clients.portal_off_at and portal_off_reason and the activity log. Needs supabase-client.js
// (supabaseClient, escapeHtml, showToast, friendlyError, logActivity). Pricing roles (the page is
// pricing-only).

function renderClientPortal(client, { reopen } = {}) {
  const el = document.getElementById('client-portal');
  if (!el) return;
  if (!client) { el.innerHTML = ''; return; }
  const dateText = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
  const logins = [client.email, ...(client.client_contacts || []).filter((c) => c.portal_access && c.email).map((c) => c.email)].filter(Boolean);
  const off = !!client.portal_off_at;
  el.innerHTML = `
    <label>Client portal</label>
    <p class="subtitle" style="margin:0 0 6px; font-size:12px;">
      ${off ? `Portal off since ${dateText(client.portal_off_at)}${client.portal_off_reason ? ` (${escapeHtml(client.portal_off_reason)})` : ''}.`
        : client.portal_last_login_at ? `Last in the portal ${dateText(client.portal_last_login_at)}.` : 'Never logged in.'}
      ${logins.length ? ` Can log in: ${escapeHtml(logins.join(', '))}.` : ' Nobody can log in yet: add the client\'s email or tick Portal on a contact.'}
    </p>
    <button type="button" class="secondary" id="cp-toggle" style="font-size:12px; padding:6px 12px;">${off ? 'Portal on' : 'Portal off'}</button>
    <a class="link-quiet" href="/portal.html" target="_blank" rel="noopener" style="font-size:12px; margin-left:8px;">Open the portal</a>
    <div id="cp-msg"></div>`;
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
