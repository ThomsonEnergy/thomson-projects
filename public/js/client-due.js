// Quote step 1, a quote the client asked for in the portal (backlog item 74 point 9): who asked,
// when they need it, and Extend (Admin, Finance, Sales) when we cannot make that date: a new date
// and a reason the client sees in the portal and gets by email. Loaded by project.html.
// Reads the project row it is given; writes through /.netlify/functions/job-client-message.

function initClientDue(project) {
  const el = document.getElementById('client-due-card');
  if (!el || !project.portal_requested_at) return;
  const esc = (s) => escapeHtml(s);
  const day = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const late = project.client_due_date && project.client_due_date < today && !project.sent_at;
  const draw = () => {
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; margin-bottom:10px; border:1px solid ${late ? 'var(--red)' : 'var(--amber)'}; border-radius:8px; background:${late ? 'var(--red-dim)' : 'var(--amber-dim)'};">
        <span><strong>Asked for in the client portal</strong> by ${esc(project.portal_requested_by || 'the client')}${project.client_due_date ? `, needed by <strong>${esc(day(project.client_due_date))}</strong>${late ? ' (late)' : ''}` : ''}${project.client_due_note ? `<br><span style="font-size:13px;">Moved: ${esc(project.client_due_note)}</span>` : ''}</span>
        ${!project.sent_at ? '<button type="button" class="secondary" id="cd-extend" style="font-size:12px; padding:6px 12px;">Extend</button>' : ''}
      </div>`;
    const btn = el.querySelector('#cd-extend');
    if (btn) btn.addEventListener('click', openExtend);
  };
  function openExtend() {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Move the due date</h2>
      <p class="subtitle">The client sees the new date in their portal and gets an email with your reason.</p>
      <label>New date</label><input type="date" id="cd-date" min="${esc(today)}" />
      <label>Why (the client reads this)</label><textarea id="cd-reason" rows="2" maxlength="300" spellcheck="true" placeholder="Waiting on battery pricing from the supplier"></textarea>
      <div id="cd-msg"></div>
      <div style="display:flex; gap:8px; margin-top:12px;"><button type="button" id="cd-save">Move it and email the client</button><button type="button" class="secondary" id="cd-cancel">Cancel</button></div>`);
    overlay.querySelector('#cd-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#cd-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const body = { action: 'extend', projectId: project.id, date: overlay.querySelector('#cd-date').value, reason: overlay.querySelector('#cd-reason').value };
        const res = await fetch('/.netlify/functions/job-client-message', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) throw new Error(out.error || `Failed (${res.status})`);
        project.client_due_date = body.date; project.client_due_note = body.reason.trim();
        overlay.remove();
        showToast(out.emailed ? 'Moved, and the client has been emailed.' : 'Moved. No client email on the quote, so no email went.');
        draw();
      } catch (err) { overlay.querySelector('#cd-msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; e.target.disabled = false; }
    });
  }
  draw();
}
