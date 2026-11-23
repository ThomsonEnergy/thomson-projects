// The clean-up buttons above the list on the Clients page (backlog item 110): Find ABNs and
// "ABNs to review (n)" for pricing roles; Find duplicates and "Duplicates to review (n)" for Admin.
// The scans run on the server (client-cleanup-background.js) and send a notification when done;
// the counts and lists come from client-cleanup.js. The panels themselves (js/client-merge.js) come
// down the first time one is opened.
//   mountClientCleanup(el, { getClients, reload }) -> { refresh, openMerge(keepClient) }
// Needs supabase-client.js (supabaseClient, friendlyError, showToast, loadJsOnce).

async function clientCleanupApi(name, body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch(`/.netlify/functions/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
  if (name.endsWith('-background')) { if (res.status === 403) throw new Error('Not allowed.'); return {}; }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.error || 'That did not work. Try again.');
  return out;
}

const loadClientMergeJs = () => loadJsOnce('/js/client-merge.js?v=1', () => typeof openClientMergePanel === 'function');

function mountClientCleanup(el, { getClients, reload }) {
  let counts = { abns: 0, duplicates: 0, isAdmin: false };

  async function refresh() {
    try { counts = await clientCleanupApi('client-cleanup', { action: 'counts' }); } catch (err) { return; }
    const btn = (id, label, n) => `<button type="button" class="secondary" id="${id}" style="font-size:13px;">${label}${n ? ` (${n})` : ''}</button>`;
    el.innerHTML = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      ${btn('cc-find-abns', 'Find ABNs', 0)}${counts.abns ? btn('cc-abns', 'ABNs to review', counts.abns) : ''}
      ${counts.isAdmin ? `${btn('cc-find-dupes', 'Find duplicates', 0)}${counts.duplicates ? btn('cc-dupes', 'Duplicates to review', counts.duplicates) : ''}` : ''}
    </div>`;
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
    const start = (run, say) => async (e) => {
      e.target.disabled = true;
      try { await clientCleanupApi('client-cleanup-background', { run }); showToast(say); }
      catch (err) { showToast(friendlyError(err), { error: true }); e.target.disabled = false; }
    };
    on('#cc-find-abns', start('abns', 'Searching the ABN register for business clients with no ABN. Carry on: a notification says when it is done.'));
    on('#cc-find-dupes', start('duplicates', 'Scanning the client list for duplicates. Carry on: a notification says when it is done.'));
    on('#cc-abns', openAbns);
    on('#cc-dupes', openDupes);
  }

  const ctx = { getClients, reload: (id) => { reload(id); refresh(); }, refresh };
  const openAbns = () => loadClientMergeJs().then(() => openAbnReview(ctx));
  const openDupes = () => loadClientMergeJs().then(() => openDuplicateReview(ctx));

  refresh().then(() => {
    // a notification's link opens the list it is about
    const want = new URLSearchParams(window.location.search).get('review');
    if (want === 'abns' && counts.abns) openAbns();
    if (want === 'duplicates' && counts.isAdmin && counts.duplicates) openDupes();
  });
  return { refresh, openMerge: (keep) => loadClientMergeJs().then(() => openClientMergePanel(keep, ctx)) };
}
