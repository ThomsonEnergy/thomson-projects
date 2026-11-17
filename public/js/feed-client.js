// The job Feed tab's "Client messages" card (backlog item 74 point 8): the job's thread with the
// client, apart from the team's own notes. The client writes from their portal; staff answer here,
// and "Email it to the client" (ticked by default) also sends it from sales@ in the sender's name.
// Loaded by project.html when the Feed tab opens. Reads job_client_messages; writes through
// /.netlify/functions/job-client-message.

async function renderClientMessages(el, project) {
  if (!el) return;
  const esc = (s) => escapeHtml(s);
  const SYD = 'Australia/Sydney';
  const when = (iso) => new Date(iso).toLocaleString('en-AU', { timeZone: SYD, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const { data, error } = await supabaseClient.from('job_client_messages').select('id, from_email, body, emailed_at, created_at, profiles(full_name)').eq('project_id', project.id).order('created_at');
  if (error) { el.innerHTML = `<div class="error-box">${esc(error.message)}</div>`; return; }
  const rows = data || [];
  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; flex-wrap:wrap;">
      <h2 style="margin:0;">Client messages</h2>
      <span class="subtitle" style="font-size:12px;">Shown in the client's portal. Team notes below stay with the team.</span>
    </div>
    <div style="max-height:320px; overflow-y:auto; margin:8px 0;">
      ${rows.length ? rows.map((m) => `
        <div style="margin:6px 0; display:flex; ${m.from_email ? '' : 'justify-content:flex-end;'}">
          <div style="max-width:80%; padding:8px 12px; border-radius:10px; background:${m.from_email ? 'var(--amber-dim)' : 'var(--surface-2)'};">
            <div style="font-size:12px; color:var(--muted);">${m.from_email ? `<span class="badge sent" style="font-size:10px;">Client</span> ${esc(m.from_email)}` : esc((m.profiles && m.profiles.full_name) || 'Us')} &middot; ${esc(when(m.created_at))}${m.emailed_at ? ' &middot; emailed' : ''}</div>
            <div style="white-space:pre-wrap; font-size:14px;">${esc(m.body)}</div>
          </div>
        </div>`).join('') : '<p class="subtitle" style="margin:4px 0;">No messages with the client yet. A client with a portal login can write to us here, and you can write to them.</p>'}
    </div>
    <textarea id="cm-body" rows="2" placeholder="Write to the client..." spellcheck="true" style="width:100%;"></textarea>
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px;">
      <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400; font-size:13px;"><input type="checkbox" id="cm-email" checked style="width:auto;" /> Email it to the client too</label>
      <button type="button" id="cm-send" style="font-size:13px;">Send to client</button>
    </div>
    <div id="cm-msg"></div>`;
  const box = el.querySelector('#cm-body');
  const scroller = box.previousElementSibling;
  scroller.scrollTop = scroller.scrollHeight;
  el.querySelector('#cm-send').addEventListener('click', async (e) => {
    const text = box.value.trim();
    if (!text) return;
    e.target.disabled = true;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/job-client-message', {
        method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reply', projectId: project.id, body: text, email: el.querySelector('#cm-email').checked }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `Failed (${res.status})`);
      if (out.warning) showToast(out.warning, { error: true }); else showToast(out.emailed ? 'Sent, and emailed to the client.' : 'Sent to the client\'s portal.');
      await renderClientMessages(el, project);
    } catch (err) {
      el.querySelector('#cm-msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}
