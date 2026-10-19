// Notification bell in the top bar + phone push setup. Loaded on every page
// by renderMainNav() in supabase-client.js. Rows in `notifications` are made by
// database triggers (see migration_132); this only shows and manages them.

const NOTIF_VAPID_PUBLIC = 'BPWaE-Nk0X9vEeR7Lq3MEtE8U7e7yDNu2DwyKFAdJAJFiWnPfmvODPcV1u2AJMB2C9sl23mRsG0_TEaBzUMPS5s';
const NOTIF_KINDS = [
  ['chat_dm', 'Chat: direct messages to me'],
  ['chat_mention', 'Chat: @mentions of me (and Sparky answering me)'],
  ['chat_reply', 'Chat: replies in threads I am in'],
  ['chat_message', 'Chat: every new message in my channels (mute a channel in Chat to stop just that one)'],
  ['tag', 'Tagged in a post or comment'],
  ['comment', 'Comments on my posts'],
  ['task_assigned', 'Tasks given to me'],
  ['task_reminder', 'Task reminders'],
  ['call_reminder', 'Call requests I have claimed (5 minutes before)'],
  ['followup_done', 'Meeting follow-ups finished (for meetings I ran)'],
  ['scheduled', 'Booked onto the schedule'],
  ['email', 'New emails in the shared inbox (admin and sales)'],
  ['supplier_bill', 'Emailed supplier bills that need checking (admin and finance)'],
  ['price_list', 'Emailed price lists with changes to check (admin and finance)'],
  ['statement', 'Supplier statements that do not reconcile, and supplier replies (admin and finance)'],
  ['ops_digest', 'Ops manager 5am digest (ops manager people)'],
  ['agent_alert', 'A background worker has stopped working (ops manager people)'],
  ['review', 'Client reviews received'],
  ['licence', 'Licence and insurance expiry reminders, and requests to update my licences'],
  ['incident', 'Incidents reported from site (admin and finance)'],
];

(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null, items = [], unread = 0, open = false, prefs = {}, prefsOpen = false, baseTitle = document.title, pushMsg = '';

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }

  function addStyles() {
    if (document.getElementById('notif-styles')) return;
    const st = document.createElement('style');
    st.id = 'notif-styles';
    st.textContent = `
      #notif-bell { position:relative; }
      #notif-badge { position:absolute; top:-5px; right:-6px; min-width:17px; height:17px; padding:0 4px; border-radius:9px; background:#e5484d; color:#fff; font-size:11px; font-weight:700; display:none; align-items:center; justify-content:center; line-height:1; }
      #notif-panel { position:fixed; top:56px; right:10px; width:min(400px, 94vw); max-height:78vh; overflow-y:auto; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.45); z-index:250; display:none; }
      #notif-panel.open { display:block; }
      .nf-head { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface); }
      .nf-head h3 { margin:0; font-size:15px; }
      .nf-link { background:none; border:none; color:var(--accent); font-size:12px; cursor:pointer; padding:2px 4px; }
      .nf-item { display:flex; gap:10px; padding:11px 14px; border-bottom:1px solid var(--border); cursor:pointer; }
      .nf-item:hover { background:var(--surface-2); }
      .nf-dot { width:9px; height:9px; border-radius:50%; background:transparent; margin-top:5px; flex-shrink:0; }
      .nf-item.unread .nf-dot { background:var(--accent); }
      .nf-item.unread .nf-title { font-weight:700; }
      .nf-title { font-size:14px; word-break:break-word; }
      .nf-body { font-size:12px; color:var(--muted); margin-top:2px; word-break:break-word; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .nf-time { font-size:11px; color:var(--muted); margin-top:3px; }
      .nf-foot { padding:12px 14px; font-size:13px; }
      .nf-foot p { margin:0 0 8px; }
      .nf-foot button { font-size:12px; padding:6px 10px; }
      .nf-prefs label { display:flex; gap:8px; align-items:flex-start; margin:0 0 6px; font-weight:400; font-size:13px; }
      .nf-prefs input { width:auto; margin-top:2px; }
    `;
    document.head.appendChild(st);
  }

  // ---------- push helpers ----------
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function keyBytes(b64) { const pad = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  async function currentSubscription() {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration('/sw.js') || await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  // Inside the TEgo iPhone app, native.js handles push (Apple push, not web push).
  const isApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  function loadNative() {
    if (!isApp() || window.TEgoNative) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/js/native.js?v=1';
      s.onload = s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  async function pushStatus() {
    if (window.TEgoNative) return window.TEgoNative.pushStatus();
    if (isIos() && !isStandalone()) return 'ios-install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted' && await currentSubscription()) return 'on';
    return 'off';
  }
  async function saveSubscription(sub) {
    const j = sub.toJSON();
    const { error } = await supabaseClient.from('push_subscriptions').upsert({
      user_id: me, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
  }
  async function enablePush() {
    if (window.TEgoNative) return window.TEgoNative.enablePush();
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. You can change this in your browser or phone settings for this site.');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(NOTIF_VAPID_PUBLIC) });
    await saveSubscription(sub);
  }
  async function disablePush() {
    if (window.TEgoNative) return window.TEgoNative.disablePush();
    const sub = await currentSubscription();
    if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); await supabaseClient.from('push_subscriptions').delete().eq('endpoint', endpoint); }
  }
  async function sendTest() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/notify-test', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send the test');
    return data;
  }

  // ---------- data ----------
  async function loadCount() {
    const { count } = await supabaseClient.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', me).is('read_at', null);
    unread = count || 0;
    const badge = document.getElementById('notif-badge');
    if (badge) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.style.display = unread ? 'flex' : 'none'; }
    document.title = (unread ? `(${unread}) ` : '') + baseTitle;
    try { if (navigator.setAppBadge) { unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge(); } } catch (e) { /* optional */ }
  }
  async function loadItems() {
    const { data } = await supabaseClient.from('notifications').select('*').eq('user_id', me).order('created_at', { ascending: false }).limit(40);
    items = data || [];
  }

  // ---------- panel ----------
  async function renderPanel() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    const status = await pushStatus();
    let pushHtml;
    if (status === 'ios-install') pushHtml = '<p>To get notifications on your iPhone lock screen, first add this app to your Home Screen (Share button, then Add to Home Screen), open it from there, and turn them on here.</p>';
    else if (status === 'unsupported') pushHtml = '<p>This browser cannot show phone notifications. Try Chrome or Safari.</p>';
    else if (status === 'denied') pushHtml = window.TEgoNative ? '<p>Notifications are turned off for TEgo. Turn them on in the iPhone Settings app, under TEgo, then Notifications.</p>' : '<p>Notifications are blocked for this site. Allow them in your browser or phone settings, then come back here.</p>';
    else if (status === 'on') pushHtml = '<p style="color:#3fb97a;">Phone notifications are on for this device.</p><button type="button" class="secondary" id="nf-test">Send a test</button> <button type="button" class="secondary" id="nf-off">Turn off</button>';
    else pushHtml = '<p>Get these on your lock screen, even when the app is closed.</p><button type="button" id="nf-on">Turn on phone notifications</button>';

    panel.innerHTML = `
      <div class="nf-head"><h3>Notifications</h3><button type="button" class="nf-link" id="nf-readall">Mark all read</button></div>
      ${items.length ? items.map(n => `
        <div class="nf-item ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || '')}">
          <span class="nf-dot"></span>
          <div style="min-width:0;"><div class="nf-title">${esc(n.title)}</div>${n.body ? `<div class="nf-body">${esc(n.body)}</div>` : ''}<div class="nf-time">${ago(n.created_at)}</div></div>
        </div>`).join('') : '<p class="subtitle" style="padding:16px 14px; margin:0;">Nothing yet. You will see tags, tasks, bookings and new emails here.</p>'}
      <div class="nf-foot">
        ${pushHtml}
        <div id="nf-push-msg" style="font-size:12px; margin-top:6px;">${pushMsg}</div>
        <p style="margin:12px 0 6px;"><button type="button" class="nf-link" id="nf-prefs-toggle">${prefsOpen ? 'Hide' : 'Choose'} what I get notified about</button></p>
        ${prefsOpen ? `<div class="nf-prefs">${NOTIF_KINDS.map(([k, label]) => `<label><input type="checkbox" data-kind="${k}" ${prefs[k] === false ? '' : 'checked'} /> ${esc(label)}</label>`).join('')}</div>` : ''}
      </div>`;
  }

  async function openPanel() {
    open = true;
    document.getElementById('notif-panel').classList.add('open');
    await Promise.all([loadItems(), supabaseClient.from('profiles').select('notification_prefs').eq('id', me).maybeSingle().then(r => { prefs = (r.data && r.data.notification_prefs) || {}; })]);
    await renderPanel();
  }
  function closePanel() { open = false; const p = document.getElementById('notif-panel'); if (p) p.classList.remove('open'); }

  async function markRead(ids) {
    if (!ids.length) return;
    await supabaseClient.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids).eq('user_id', me);
  }

  function wirePanel() {
    const panel = document.getElementById('notif-panel');
    panel.addEventListener('click', async (e) => {
      const item = e.target.closest('.nf-item');
      if (item) {
        const link = item.dataset.link;
        await markRead([item.dataset.id]);
        if (link) window.location.href = link; else { await loadCount(); await loadItems(); await renderPanel(); }
        return;
      }
      const id = e.target.id;
      if (id === 'nf-readall') { await markRead(items.filter(n => !n.read_at).map(n => n.id)); await Promise.all([loadCount(), loadItems()]); await renderPanel(); }
      else if (id === 'nf-prefs-toggle') { prefsOpen = !prefsOpen; await renderPanel(); }
      else if (id === 'nf-on') {
        try { await enablePush(); pushMsg = ''; } catch (err) { pushMsg = `<span style="color:var(--red);">${esc(err.message)}</span>`; }
        await renderPanel();
      } else if (id === 'nf-off') { try { await disablePush(); pushMsg = ''; } catch (err) { pushMsg = esc(err.message); } await renderPanel(); }
      else if (id === 'nf-test') {
        const btn = e.target; btn.disabled = true; btn.textContent = 'Sending...';
        try {
          const r = await sendTest();
          pushMsg = r.sent ? 'Sent. It should arrive on your device in a moment.' : (r.devices ? '<span style="color:var(--red);">It could not be delivered. Try turning phone notifications off and on again.</span>' : '<span style="color:var(--red);">No device is registered yet. Turn on phone notifications first.</span>');
        } catch (err) { pushMsg = `<span style="color:var(--red);">${esc(err.message)}</span>`; }
        await Promise.all([loadCount(), loadItems()]); await renderPanel();
      }
    });
    panel.addEventListener('change', async (e) => {
      const k = e.target.dataset && e.target.dataset.kind;
      if (!k) return;
      prefs = { ...prefs, [k]: e.target.checked };
      await supabaseClient.from('profiles').update({ notification_prefs: prefs }).eq('id', me);
    });
  }

  async function init() {
    const right = document.querySelector('.topbar-right');
    if (!right || document.getElementById('notif-bell')) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;
    me = session.user.id;
    await loadNative();
    addStyles();

    const bell = document.createElement('a');
    bell.href = '#'; bell.id = 'notif-bell'; bell.className = 'topbar-icon-link'; bell.title = 'Notifications';
    bell.innerHTML = '&#128276;<span id="notif-badge"></span>';
    right.insertBefore(bell, right.firstChild);
    const panel = document.createElement('div');
    panel.id = 'notif-panel';
    document.body.appendChild(panel);
    wirePanel();

    bell.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); if (open) closePanel(); else await openPanel(); });
    document.addEventListener('click', (e) => { if (open && !panel.contains(e.target) && !bell.contains(e.target)) closePanel(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

    await loadCount();
    setInterval(() => { loadCount(); if (open) loadItems().then(renderPanel); }, 60000);
    try {
      supabaseClient.channel('notif-' + me)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${me}` }, () => { loadCount(); if (open) loadItems().then(renderPanel); })
        .subscribe();
    } catch (e) { /* the 60 second refresh still keeps it current */ }

    // keep this device's push registration fresh (once per browser session)
    try {
      if (!window.TEgoNative && !sessionStorage.getItem('te-push-synced') && (await pushStatus()) === 'on') {
        const sub = await currentSubscription();
        if (sub) { await saveSubscription(sub); sessionStorage.setItem('te-push-synced', '1'); }
      }
    } catch (e) { /* not critical */ }
  }

  init().catch(err => console.error('Notifications failed to start:', err));
})();
