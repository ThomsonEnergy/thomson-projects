// A client's statement, from staff pages (owner, 15 and 16 Nov 2026): what the client owes across all
// their jobs, with Open statement (statement.html?token=, always current) and Email statement (the
// PDF as at today from generate-client-document-pdf, client_statement, plus the link, from sales@
// through the usual composer). Invoices are not changed: each one stays its own amount, and the
// statement links to them. Two doors, one code path:
//   renderClientStatement(client)              the Statement line on the Clients page (clients.html)
//   emailStatementForClient(clientId, { btn, msgEl })  Email statement on the invoice panel
//                                              (js/invoice-actions.js), for the client the invoice is billed to
// Downloaded on first use. Writes the activity log only. Needs supabase-client.js (supabaseClient,
// escapeHtml, money, shareOrigin, showToast, friendlyError, logActivity, loadJsOnce).
// Every send is one activity_log row (entity client, action statement_sent); statementSendsHtml
// reads them back as "Last sent ..." with a History fold, on both doors (item 112).

const STATEMENT_CLIENT_SELECT = 'id, name, email, statement_token, client_contacts(name, email, contact_type)';

// What the client owes now, from the same function the statement page reads.
async function loadClientStatement(client) {
  const { data, error } = await supabaseClient.rpc('get_client_statement_by_token', { p_token: client.statement_token });
  if (error || !data) throw error || new Error('Statement not found');
  const rows = data.invoices || [];
  const dueOf = (r) => r.due_date || (r.sent_at ? new Date(r.sent_at).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) : null);
  const sum = (list) => list.reduce((t, r) => t + (Number(r.balance) || 0), 0);
  const late = rows.filter((r) => dueOf(r) && dueOf(r) < data.as_at);
  return { rows, total: sum(rows), lateCount: late.length, lateTotal: sum(late), asAt: data.as_at, dueOf,
    url: shareOrigin() + '/statement.html?token=' + encodeURIComponent(client.statement_token) };
}

// The sends so far, newest first: [{ created_at, description, profiles: { full_name } }].
async function loadStatementSends(clientId) {
  const { data, error } = await supabaseClient.from('activity_log')
    .select('created_at, description, profiles(full_name)')
    .eq('entity_type', 'client').eq('entity_id', clientId).eq('action', 'statement_sent')
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data || [];
}

// "Last sent 21 Nov 2026 by Jasper" and a History fold of every send. Empty when none was sent.
function statementSendsHtml(sends) {
  if (!sends.length) return '<p class="subtitle" style="margin:6px 0 0; font-size:12px;">Statement not sent yet.</p>';
  const day = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
  const who = (s) => (s.profiles && s.profiles.full_name ? ` by ${escapeHtml(s.profiles.full_name)}` : '');
  // the log line reads "Statement as at 21 Nov 2026 ($1,200.00 owing) sent to a@b.com": keep who it went to
  const to = (s) => { const m = / sent to (.+)$/.exec(s.description || ''); return m ? ` to ${escapeHtml(m[1])}` : ''; };
  const rows = sends.map((s) => `<div style="font-size:12px; padding:3px 0; border-top:1px solid var(--border);">${day(s.created_at)}${who(s)}: ${escapeHtml(s.description || '')}</div>`).join('');
  return `<details style="margin-top:6px;"><summary class="subtitle" style="font-size:12px; cursor:pointer;">Statement last sent ${day(sends[0].created_at)}${to(sends[0])}${who(sends[0])} (History, ${sends.length})</summary>${rows}</details>`;
}

// Draws the sends into el (the Clients page line, or the invoice panel's message area).
async function showStatementSends(clientId, el) {
  if (!el) return;
  try { el.innerHTML = statementSendsHtml(await loadStatementSends(clientId)); } catch (err) { el.innerHTML = ''; }
}

async function renderClientStatement(client) {
  const el = document.getElementById('client-statement');
  if (!el) return;
  if (!client || !client.statement_token) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="subtitle" style="margin:0; font-size:12px;">Working out what is owing...</p>';
  let st;
  try { st = await loadClientStatement(client); } catch (err) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
  el.innerHTML = `
    <label style="margin-top:0;">Statement</label>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <span style="font-size:13px;">${st.rows.length
        ? `<strong>${money(st.total)}</strong> owing on ${st.rows.length} invoice${st.rows.length === 1 ? '' : 's'}${st.lateCount ? `, <span style="color:var(--red); font-weight:700;">${money(st.lateTotal)} overdue</span>` : ''}`
        : 'Nothing owing.'}</span>
      <a class="btn secondary" href="${escapeHtml(st.url)}" target="_blank" rel="noopener" style="font-size:12px; padding:6px 12px;">Open statement</a>
      ${st.rows.length ? '<button type="button" class="secondary" id="cs-email-btn" style="font-size:12px; padding:6px 12px;">Email statement</button>' : ''}
    </div>
    <div id="cs-sends"></div>
    <div id="cs-msg"></div>`;
  const sendsEl = el.querySelector('#cs-sends');
  showStatementSends(client.id, sendsEl);
  const btn = el.querySelector('#cs-email-btn');
  if (btn) btn.addEventListener('click', () => emailClientStatement(client, st, btn, el.querySelector('#cs-msg'), sendsEl));
}

// From the invoice panel: the client is read fresh (with contacts and the statement link).
async function emailStatementForClient(clientId, { btn, msgEl, sendsEl } = {}) {
  try {
    const { data: client, error } = await supabaseClient.from('clients').select(STATEMENT_CLIENT_SELECT).eq('id', clientId).single();
    if (error) throw error;
    const st = await loadClientStatement(client);
    if (!st.rows.length) { showToast(`${client.name} owes nothing, so there is no statement to send.`); return; }
    await emailClientStatement(client, st, btn, msgEl, sendsEl);
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; else showToast(friendlyError(err), { error: true });
  }
}

// sendsEl: where "Last sent ..." is drawn again once this one has gone.
async function emailClientStatement(client, st, btn, msgEl, sendsEl) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Making the PDF...'; }
  if (msgEl) msgEl.innerHTML = '';
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const [res] = await Promise.all([
      fetch('/.netlify/functions/generate-client-document-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ doc_type: 'client_statement', record_id: client.id }),
      }),
      loadJsOnce('/js/email-compose.js?v=14', () => typeof openEmailComposer === 'function'),
    ]);
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok || !out.path) throw new Error(out.error || 'The PDF could not be made.');
    const asAt = new Date(st.asAt + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    // to the accounts contact when there is one, else the client's email, else any contact's
    const contacts = (client.client_contacts || []).filter((c) => c.email);
    const accounts = contacts.find((c) => c.contact_type === 'accounts');
    const to = accounts?.email || client.email || contacts[0]?.email || '';
    const first = String(accounts?.name || client.name || '').trim().split(/\s+/)[0] || 'there';
    const list = st.rows.map((r) => `${String(r.invoice_number).replace(/^INV-?/i, '')}${r.job_number ? ` (J${r.job_number})` : ''}: ${money(r.balance)}${st.dueOf(r) && st.dueOf(r) < st.asAt ? ', overdue' : ''}`).join('\n');
    openEmailComposer({
      title: `Email the statement to ${client.name}`,
      to,
      subject: `Statement from Thomson Energy, as at ${asAt}`,
      body: `Hi ${first},\n\nAttached is your statement as at ${asAt}: ${money(st.total)} owing${st.lateTotal > 0 ? `, of which ${money(st.lateTotal)} is overdue` : ''}.\n\n${list}\n\nYou can pay the total by bank transfer (details on the statement), or open the statement online with the button below and click an invoice to pay it by card.\n\nIf anything here is already paid, please let us know.\n\nThanks,`,
      tagKind: 'client',
      // a button, as the invoice email has, never the address typed into the message
      quoteLink: { url: st.url, label: 'Include a button to view and pay the statement online', buttonText: 'View and pay your statement', checked: true },
      attachOptions: [{ group: 'Documents', label: `Statement as at ${asAt} (PDF)`, bucket: 'project-documents', path: out.path, name: `Thomson Energy statement ${st.asAt}.pdf`, checked: true }],
      onSent: async (threadId, sent) => {
        await logActivity('client', client.id, 'statement_sent', `Statement as at ${asAt} (${money(st.total)} owing) sent to ${(sent && sent.to) || to || 'the client'}`);
        showToast('Statement sent');
        await showStatementSends(client.id, sendsEl);
      },
    });
  } catch (err) {
    const text = friendlyError(err);
    if (msgEl) msgEl.innerHTML = `<div class="error-box">${escapeHtml(text)}</div>`; else showToast(text, { error: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
