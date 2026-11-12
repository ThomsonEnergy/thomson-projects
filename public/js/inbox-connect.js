// My inbox: connect (the Workplace Surveillance Act notice, the Google sign-in) and disconnect.
// Loaded by inbox.html only when My inbox is not connected or Disconnect is pressed (rare
// screens, so not part of the page's load). Reads gmail_connect_notices; connecting goes through
// google-oauth-start, disconnecting through email-actions.js (disconnect). Needs
// supabase-client.js (supabaseClient, escapeHtml). Called with the page's state and helpers.

const NOTICE_TEXT = `Connecting your work Gmail to TEops

What happens if you connect
- TEops copies your work email (your @thomsonenergy.com.au inbox): the last 60 days, then new email as it arrives, so you can read, sort and reply from TEops.
- ${'{assistant}'} (the AI in TEops) reads your work email to sort it (needs a reply, other, subscriptions and updates), file it under labels, match it to jobs and draft replies for you to check. Nothing is ever sent without you pressing Send.
- Emails tagged to a job show on that job for the team. Everything else in your inbox stays private to you: other staff, directors included, do not see it in TEops.
- You can disconnect any time in Inbox > My inbox. Your private emails are then removed from TEops straight away; emails tagged to a job stay on the job as business records.

Your rights under the Workplace Surveillance Act 2005 (NSW)
- TEops reading your work email this way is computer surveillance under the Act. The law says you must get written notice at least 14 days before it starts. This is that notice.
- You can agree to it starting now. Agreeing waives the 14 days notice for this. It is your choice.
- If you do not agree, nothing is connected now and nothing changes for your job or pay. Connect becomes available 14 days from today, and only if you choose to press it then.

Please also read the Notice of Workplace Surveillance and Computer Surveillance Policy in your signed documents.`;

async function renderInboxConnect({ S, onePane, act, loadMailboxes, showBox }) {
  S.listSeq++; // a list still loading must not paint over this screen
  document.getElementById('inbox-side').innerHTML = '';
  onePane(true);
  const listEl = document.getElementById('thread-list');
  const { data: notices } = await supabaseClient.from('gmail_connect_notices').select('*').eq('profile_id', S.me.id).order('created_at');
  const agreed = (notices || []).some(n => n.response === 'agree');
  const first = (notices || [])[0];
  const allowedFrom = agreed ? new Date() : first ? new Date(new Date(first.created_at).getTime() + 14 * 86400000) : null;
  const locked = allowedFrom && allowedFrom > new Date();
  let html = `<div style="max-width:620px; padding:12px 14px;">
    <h2 style="margin-top:0;">Bring your own work email into TEops</h2>
    <p>See your work Gmail next to the Sales inbox, with ${escapeHtml(S.assistant)} sorting it into what needs a reply, what can wait and subscriptions, filing it under labels and jobs, and drafting replies for you. Private to you.</p>`;
  if (S.mine && S.mine.disconnected_at && !S.mine.connected_at) html += `<p class="subtitle">You disconnected ${escapeHtml(S.mine.address)} on ${new Date(S.mine.disconnected_at).toLocaleDateString('en-AU')}.</p>`;
  if (locked) {
    html += `<div class="card" style="padding:12px 14px;">You chose not to agree on ${new Date(first.created_at).toLocaleDateString('en-AU')}. Connect is available from <strong>${allowedFrom.toLocaleDateString('en-AU')}</strong> (14 days after the notice).</div>
      <p style="margin-top:12px;"><button type="button" class="secondary" id="read-notice-btn">Read the notice again (and agree now if you have changed your mind)</button></p>`;
  } else {
    html += `<p><button type="button" id="connect-btn">Connect my Gmail</button></p>`;
  }
  listEl.innerHTML = html + '</div>';
  const btn = document.getElementById('connect-btn') || document.getElementById('read-notice-btn');
  btn.addEventListener('click', () => (allowedFrom && !locked ? startConnect() : openNotice({ S, onePane, act, loadMailboxes, showBox })));
}

function openNotice(ctx) {
  const { S } = ctx;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:120; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:640px; width:100%; max-height:92vh; overflow-y:auto;">
      <h2 style="margin-top:0;">Before you connect: workplace surveillance notice</h2>
      <div class="notice">${escapeHtml(NOTICE_TEXT.replace('{assistant}', S.assistant))}</div>
      <div style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">
        <button type="button" id="nt-agree">I agree and waive the 14 days notice: connect now</button>
        <button type="button" class="secondary" id="nt-disagree">I don't agree</button>
        <button type="button" class="secondary" id="nt-cancel">Not now</button>
      </div>
      <div id="nt-msg" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  const record = async (response) => {
    const { error } = await supabaseClient.from('gmail_connect_notices').insert({ profile_id: S.me.id, response, notice_version: NOTICE_VERSION });
    if (error) throw error;
  };
  overlay.querySelector('#nt-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#nt-disagree').addEventListener('click', async () => {
    try { await record('disagree'); } catch (err) { overlay.querySelector('#nt-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; return; }
    overlay.remove(); renderInboxConnect(ctx);
  });
  overlay.querySelector('#nt-agree').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Opening Google...';
    try { await record('agree'); await startConnect(); } catch (err) {
      overlay.querySelector('#nt-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      e.target.disabled = false; e.target.textContent = 'I agree and waive the 14 days notice: connect now';
    }
  });
}

async function startConnect() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/google-oauth-start?mailbox=mine', { headers: { Authorization: `Bearer ${session.access_token}` } });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) { alert(data.error || 'Could not start the Google sign in.'); return; }
  window.location.href = data.url;
}

async function disconnectMyInbox({ S, act, loadMailboxes, showBox }) {
  if (!confirm('Disconnect your Gmail from TEops? Your private emails are removed from TEops straight away. Emails tagged to a job stay on the job. Your Gmail itself is not changed.')) return;
  try {
    const r = await act('disconnect', { mailbox_id: S.mine.id });
    alert(`Disconnected. ${r.removed} conversations removed from TEops, ${r.kept} kept on their jobs.`);
  } catch (err) { alert(err.message); return; }
  await loadMailboxes();
  S.view = 'priority';
  showBox('mine');
}
