// Team chat (chat.html). Channels and DMs, threads, photos, files, voice
// messages, @mentions, job tags (type #) and Sparky (@Sparky answers, job
// tags with Yes / No / Undo). Database side: migration 20261020000000.
//
// Sending is save-locally-then-sync: every message goes into an IndexedDB
// outbox first (with the time Send was pressed), shows straight away as
// "Sending...", and is uploaded when there is signal. The client_id stops a
// retry from ever making a second copy. New messages arrive by Supabase
// Realtime; the list also refreshes whenever the app comes back on screen.

(function () {
  const esc = (s) => escapeHtml(s);
  const S = {
    me: null, role: null, isAdmin: false, botName: 'Sparky',
    staff: [], staffById: {}, channels: [], current: null,
    messages: [], threadRoot: null, threadMsgs: [], hasOlder: false,
    projects: {}, urls: {}, outbox: [], botWaiting: {}, filter: '',
  };
  const app = document.getElementById('chat-app');
  const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

  // ---------- small helpers ----------
  function initials(name) { return (String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase(); }
  function colour(name) { let h = 0; String(name || '').split('').forEach(ch => { h = (h * 31 + ch.charCodeAt(0)) % 360; }); return `hsl(${h}, 45%, 42%)`; }
  function avatar(person, isBot) {
    if (isBot) return `<div class="cm-avatar bot">${typeof aiRobotSvg === 'function' ? aiRobotSvg(36) : '&#129302;'}</div>`;
    const name = person ? person.full_name : 'Someone';
    if (person && person.photo_url) {
      const src = typeof supaImageVariant === 'function' ? supaImageVariant(person.photo_url, 96, 70) : person.photo_url;
      return `<img class="cm-avatar" src="${esc(src)}" alt="" onerror="this.outerHTML='<div class=&quot;cm-avatar&quot; style=&quot;background:${colour(name)}&quot;>${esc(initials(name))}</div>'" />`;
    }
    return `<div class="cm-avatar" style="background:${colour(name)}">${esc(initials(name))}</div>`;
  }
  const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  function dayOf(iso) {
    const d = new Date(iso); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function whenShort(iso) {
    if (!iso) return '';
    const d = new Date(iso); const now = new Date();
    if (d.toDateString() === now.toDateString()) return timeOf(iso);
    if (now - d < 6 * 86400000) return d.toLocaleDateString('en-AU', { weekday: 'short' });
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }
  const jobLabel = (p) => (p ? (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : '') + (p.name ? ` ${p.name}` : '') : 'Job');
  function botRegex() {
    const names = [...new Set([S.botName, 'Sparky', 'Claude'].map(n => n.toLowerCase().replace(/[^a-z0-9]/g, '')))];
    return new RegExp(`(^|[^\\w])@(${names.join('|')})\\b`, 'i');
  }
  async function token() { const { data: { session } } = await supabaseClient.auth.getSession(); return session && session.access_token; }
  function toast(msg) { alert(msg); }

  // Message text: escaped, links clickable, @names highlighted.
  function renderBody(text) {
    let html = esc(text);
    html = html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    const names = S.staff.map(s => s.full_name).filter(Boolean).sort((a, b) => b.length - a.length);
    const meName = S.staffById[S.me] && S.staffById[S.me].full_name;
    for (const n of [S.botName, ...names]) {
      const safe = esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`@${safe}(?![\\w])`, 'g'), `<span class="cm-at${n === meName ? ' me' : ''}">@${esc(n)}</span>`);
    }
    return html;
  }

  // ---------- IndexedDB outbox ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('teops-chat', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'client_id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('outbox', mode);
      const r = fn(tx.objectStore('outbox'));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const outboxAll = () => idb('readonly', s => s.getAll()).then(r => (r || []).filter(x => x.author_id === S.me).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  const outboxPut = (rec) => idb('readwrite', s => s.put(rec));
  const outboxDel = (id) => idb('readwrite', s => s.delete(id));

  // ---------- data ----------
  async function loadStaff() {
    const { data } = await supabaseClient.from('profiles').select('id, full_name, photo_url, active').order('full_name');
    S.staff = (data || []).filter(p => p.active);
    S.staffById = Object.fromEntries((data || []).map(p => [p.id, p]));
  }
  async function loadChannels() {
    const { data, error } = await supabaseClient.rpc('chat_my_channels');
    if (error) { document.getElementById('ch-list').innerHTML = `<div class="error-box" style="margin:14px;">${esc(error.message)}</div>`; return; }
    S.channels = data || [];
    renderList();
  }
  const chanById = (id) => S.channels.find(c => c.id === id);
  function chanTitle(c) {
    if (!c) return '';
    if (c.kind === 'dm') return (c.members || []).map(m => m.full_name).join(', ') || 'Just you';
    return '#' + c.name;
  }

  async function loadProjects(ids) {
    const want = [...new Set(ids.filter(id => id && !S.projects[id]))];
    if (!want.length) return;
    const { data } = await supabaseClient.from('projects').select('id, name, job_number, quote_number').in('id', want);
    (data || []).forEach(p => { S.projects[p.id] = p; });
  }
  async function signUrls(msgs) {
    const now = Date.now();
    const paths = [];
    msgs.forEach(m => (m.attachments || []).forEach(a => { if (a.path && !(S.urls[a.path] && S.urls[a.path].exp > now)) paths.push(a.path); }));
    if (!paths.length) return;
    const { data } = await supabaseClient.storage.from('chat').createSignedUrls([...new Set(paths)], 3600);
    (data || []).forEach(r => { if (r.signedUrl) S.urls[r.path] = { url: r.signedUrl, exp: now + 3500 * 1000 }; });
  }
  async function prepare(msgs) {
    await Promise.all([
      loadProjects(msgs.flatMap(m => [m.project_id, m.tag_suggested_project_id])),
      signUrls(msgs),
    ]);
  }

  const PAGE = 50;
  async function fetchMessages(channelId, before) {
    let q = supabaseClient.from('chat_messages').select('*').eq('channel_id', channelId).is('parent_id', null)
      .order('created_at', { ascending: false }).limit(PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).reverse();
  }

  // ---------- chat list ----------
  function renderList() {
    const el = document.getElementById('ch-list');
    const f = S.filter.trim().toLowerCase();
    const shown = S.channels.filter(c => !f || chanTitle(c).toLowerCase().includes(f) || (c.description || '').toLowerCase().includes(f));
    const item = (c) => {
      const isDm = c.kind === 'dm';
      const first = isDm && c.members && c.members[0];
      const ico = isDm
        ? (c.members && c.members.length === 1 ? avatar(first, false).replace('cm-avatar', 'cm-avatar ch-ico') : `<div class="ch-ico">${(c.members || []).length + 1}</div>`)
        : `<div class="ch-ico">${c.is_social ? '&#127867;' : '#'}</div>`;
      const last = c.last_body ? `${c.last_is_bot ? esc(S.botName) + ': ' : (!isDm && c.last_author ? esc(c.last_author.split(' ')[0]) + ': ' : '')}${esc(c.last_body)}` : esc(c.description || '');
      const badge = c.mention_unread ? `<span class="ch-badge at">@${c.mention_unread}</span>` : (c.unread ? `<span class="ch-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '');
      return `<div class="ch-item ${S.current && S.current.id === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''} ${c.muted ? 'muted' : ''}" data-id="${c.id}">
        ${ico}
        <div class="ch-txt"><div class="ch-name">${esc(chanTitle(c))}${c.muted ? ' &#128263;' : ''}</div><div class="ch-last">${last}</div></div>
        <div class="ch-meta"><span class="ch-when">${whenShort(c.last_message_at)}</span>${badge}</div>
      </div>`;
    };
    const live = shown.filter(c => !c.archived_at);
    const chans = live.filter(c => c.kind === 'channel');
    const dms = live.filter(c => c.kind === 'dm');
    const archived = shown.filter(c => c.archived_at);
    el.innerHTML = (chans.length ? `<div class="ch-sec">Channels</div>${chans.map(item).join('')}` : '')
      + `<div class="ch-sec">Direct messages</div>${dms.length ? dms.map(item).join('') : '<p class="subtitle" style="padding:4px 14px; font-size:13px;">Tap New to message someone.</p>'}`
      + (archived.length ? `<div class="ch-sec">Archived</div>${archived.map(item).join('')}` : '');
    el.querySelectorAll('.ch-item').forEach(n => n.addEventListener('click', () => openChannel(n.dataset.id)));
  }

  // ---------- phone history ----------
  // Phones: opening a conversation or thread adds a history entry, so the
  // iPhone back swipe returns to the list instead of leaving Chat. The back
  // buttons step back through that entry; popstate runs the same close code.
  function setUrl(url, push) {
    if (push && isPhone()) history.pushState({ teChat: 1 }, '', url);
    else history.replaceState(history.state, '', url);
  }
  function goBack(fallback) {
    if (isPhone() && history.state && history.state.teChat) history.back();
    else fallback();
  }
  function closeConv() {
    closeThread(true);
    app.classList.remove('show-conv'); S.current = null; renderList();
  }
  window.addEventListener('popstate', async () => {
    const p = new URLSearchParams(location.search);
    const c = p.get('c'), t = p.get('t');
    if (!c) { if (S.current) closeConv(); return; }
    if (!S.current || S.current.id !== c) await openChannel(c, { keepUrl: true });
    if (t) { if (!S.threadRoot || S.threadRoot.id !== t) await openThread(t, { keepUrl: true }); }
    else if (S.threadRoot) closeThread(true);
  });

  // ---------- conversation ----------
  async function openChannel(id, opts = {}) {
    let c = chanById(id);
    if (!c) { await loadChannels(); c = chanById(id); }
    if (!c) { toast('That chat could not be found, or you are not in it.'); return; }
    const wasOpen = app.classList.contains('show-conv');
    S.current = c; S.messages = []; S.hasOlder = false;
    closeThread(true);
    app.classList.add('show-conv');
    renderList();
    const conv = document.getElementById('ch-conv');
    const sub = c.kind === 'dm' ? `${(c.members || []).length + 1} people` : (c.description || (c.everyone ? 'Everyone' : 'Channel'));
    conv.innerHTML = `
      <div class="ch-head">
        <button type="button" class="ch-back" id="ch-back" aria-label="Back">&#8249;</button>
        <div class="ch-title"><b>${esc(chanTitle(c))}</b><span>${esc(sub)}</span></div>
        <button type="button" class="secondary" id="ch-mute" title="${c.muted ? 'Unmute' : 'Mute'}">${c.muted ? '&#128263;' : '&#128276;'}</button>
        ${S.isAdmin && c.kind === 'channel' ? '<button type="button" class="secondary" id="ch-settings" title="Channel settings">&#9881;</button>' : ''}
      </div>
      <div class="ch-msgs" id="ch-msgs"><p class="subtitle" style="padding:14px;">Loading...</p></div>
      <div id="ch-composer"></div>`;
    document.getElementById('ch-back').addEventListener('click', () => goBack(() => { closeConv(); history.replaceState(null, '', '/chat.html'); }));
    document.getElementById('ch-mute').addEventListener('click', toggleMute);
    const st = document.getElementById('ch-settings');
    if (st) st.addEventListener('click', () => channelModal(c));
    mountComposer(document.getElementById('ch-composer'), { channelId: c.id, parentId: null, placeholder: c.kind === 'dm' ? 'Message' : `Message #${c.name}` });
    if (!opts.keepUrl) setUrl(`/chat.html?c=${c.id}`, !wasOpen);

    try {
      S.messages = await fetchMessages(c.id);
      S.hasOlder = S.messages.length === PAGE;
      // Opened from a notification for an older message: load back to it.
      for (let i = 0; opts.messageId && i < 6 && S.hasOlder && !S.messages.some(m => m.id === opts.messageId); i++) {
        const older = await fetchMessages(c.id, S.messages[0].created_at);
        S.messages = older.concat(S.messages); S.hasOlder = older.length === PAGE;
      }
      await prepare(S.messages);
    } catch (err) {
      document.getElementById('ch-msgs').innerHTML = `<div class="error-box" style="margin:14px;">${esc(err.message)}</div>`;
      return;
    }
    if (!S.current || S.current.id !== c.id) return;
    renderMessages();
    if (opts.messageId) flashMessage(opts.messageId);
    markRead();
  }

  function pendingFor(channelId, parentId) {
    return S.outbox.filter(r => r.channel_id === channelId && (r.parent_id || null) === (parentId || null));
  }

  function renderMessages(keepScroll) {
    const el = document.getElementById('ch-msgs');
    if (!el || !S.current) return;
    const prevH = el.scrollHeight, prevTop = el.scrollTop;
    const list = S.messages;
    let html = S.hasOlder ? '<div class="ch-more-older"><button type="button" class="secondary" id="ch-older">Load earlier messages</button></div>' : '';
    if (!list.length && !pendingFor(S.current.id, null).length) {
      html += `<p class="subtitle" style="padding:20px 14px; text-align:center;">No messages yet. Say g'day.</p>`;
    }
    html += listHtml(list, false);
    html += pendingFor(S.current.id, null).map(r => pendingHtml(r)).join('');
    if (S.botWaiting[S.current.id + ':']) html += `<div class="cm-bot-typing">${esc(S.botName)} is looking into it...</div>`;
    el.innerHTML = html;
    wireMessages(el);
    const older = document.getElementById('ch-older');
    if (older) older.addEventListener('click', loadOlder);
    if (keepScroll === 'top') el.scrollTop = el.scrollHeight - prevH + prevTop;
    else if (keepScroll === 'stay') el.scrollTop = prevTop;
    else el.scrollTop = el.scrollHeight;
    fillImages(el);
  }

  function listHtml(list, inThread) {
    let html = '', lastDay = null, prev = null;
    for (const m of list) {
      const day = dayOf(m.created_at);
      if (day !== lastDay) { html += `<div class="ch-day"><span>${esc(day)}</span></div>`; lastDay = day; prev = null; }
      const compact = prev && !prev.deleted_at && prev.author_id === m.author_id && prev.is_bot === m.is_bot && (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60000;
      html += msgHtml(m, { compact, inThread });
      prev = m;
    }
    return html;
  }

  function attachmentsHtml(atts, localUrls) {
    if (!atts || !atts.length) return '';
    const urlOf = (a, i) => (localUrls && localUrls[i]) || (S.urls[a.path] && S.urls[a.path].url) || '';
    const imgs = atts.map((a, i) => ({ a, i })).filter(x => x.a.kind === 'image');
    let html = '';
    if (imgs.length) {
      html += `<div class="cm-imgs ${imgs.length === 1 ? 'one' : ''}">${imgs.map(({ a, i }) => `<img loading="lazy" data-path="${esc(a.path || '')}" src="${esc(urlOf(a, i))}" alt="${esc(a.name || 'Photo')}" />`).join('')}</div>`;
    }
    atts.forEach((a, i) => {
      if (a.kind === 'voice') {
        const secs = a.duration ? ` (${Math.floor(a.duration / 60)}:${String(Math.round(a.duration % 60)).padStart(2, '0')})` : '';
        html += `<div class="cm-voice"><audio controls preload="none" src="${esc(urlOf(a, i))}"></audio><span class="cm-time">Voice message${secs}</span></div>`;
      } else if (a.kind !== 'image') {
        const kb = a.size ? ` (${a.size > 1048576 ? (a.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size / 1024)) + ' KB'})` : '';
        html += `<div><a class="cm-file" href="${esc(urlOf(a, i))}" target="_blank" rel="noopener" data-path="${esc(a.path || '')}">&#128206; <span>${esc(a.name || 'File')}${kb}</span></a></div>`;
      }
    });
    return html;
  }

  function tagHtml(m) {
    if (m.deleted_at) return '';
    if (m.project_id) {
      const p = S.projects[m.project_id];
      const byAi = m.tagged_by === 'ai';
      const confirmed = byAi && m.tagged_by_profile_id;
      return `<div class="cm-tag"><a class="cm-chip" href="/project.html?id=${m.project_id}&tab=feed">&#128204; ${esc(jobLabel(p))}</a>
        ${byAi ? `<span>tagged by ${esc(S.botName)}${confirmed ? ', confirmed' : ''}</span> <button type="button" class="cm-link" data-act="untag" data-id="${m.id}">Undo</button>` : ''}</div>`;
    }
    if (m.tag_suggested_project_id) {
      const p = S.projects[m.tag_suggested_project_id];
      return `<div class="cm-tag"><span class="cm-suggest">${esc(S.botName)} thinks this is <a class="cm-chip" href="/project.html?id=${m.tag_suggested_project_id}">${esc(jobLabel(p))}</a>
        <button type="button" class="cm-link" data-act="yes" data-id="${m.id}">Yes</button><button type="button" class="cm-link" data-act="no" data-id="${m.id}">No</button></span></div>`;
    }
    return '';
  }

  function msgHtml(m, { compact, inThread }) {
    const person = m.is_bot ? null : S.staffById[m.author_id];
    const name = m.is_bot ? S.botName : (person ? person.full_name : 'Former staff');
    const body = m.deleted_at
      ? '<div class="cm-deleted">Message deleted</div>'
      : `${m.body ? `<div class="cm-body">${renderBody(m.body)}</div>` : ''}${attachmentsHtml(m.attachments)}${m.voice_transcript ? `<div class="cm-transcript">&ldquo;${esc(m.voice_transcript)}&rdquo;</div>` : ''}`;
    const thread = !inThread && m.reply_count
      ? `<div class="cm-thread-link"><button type="button" class="cm-link" data-act="thread" data-id="${m.id}">&#128172; ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}${m.last_reply_at ? ` <span class="cm-time">last ${esc(whenShort(m.last_reply_at))}</span>` : ''}</button></div>` : '';
    return `<div class="cm ${compact ? 'compact' : ''}" data-id="${m.id}">
      <div class="cm-av">${compact ? '' : avatar(person, m.is_bot)}</div>
      <div class="cm-main">
        ${compact ? '' : `<div class="cm-head"><b>${esc(name)}</b><span class="cm-time">${timeOf(m.created_at)}</span>${m.edited_at && !m.deleted_at ? '<span class="cm-edited">(edited)</span>' : ''}</div>`}
        ${body}${tagHtml(m)}${thread}
      </div>
      ${m.deleted_at ? '' : `<button type="button" class="cm-more" data-act="menu" data-id="${m.id}" aria-label="More">&#8943;</button>`}
    </div>`;
  }

  function pendingHtml(r) {
    const status = r.status === 'failed'
      ? `<div class="cm-status err">Not sent: ${esc(r.error || 'error')} <button type="button" class="cm-link" data-act="retry" data-cid="${r.client_id}">Try again</button><button type="button" class="cm-link" data-act="discard" data-cid="${r.client_id}">Delete</button></div>`
      : `<div class="cm-status">${navigator.onLine ? 'Sending...' : 'Waiting for signal...'}</div>`;
    if (!r._urls) r._urls = (r.files || []).map(f => URL.createObjectURL(f.blob));
    const atts = (r.files || []).map(f => ({ kind: f.kind, name: f.name, size: f.size, duration: f.duration }));
    const me = S.staffById[S.me];
    return `<div class="cm pending" data-cid="${r.client_id}">
      <div class="cm-av">${avatar(me, false)}</div>
      <div class="cm-main">
        <div class="cm-head"><b>${esc(me ? me.full_name : 'Me')}</b><span class="cm-time">${timeOf(r.created_at)}</span></div>
        ${r.body ? `<div class="cm-body">${renderBody(r.body)}</div>` : ''}${attachmentsHtml(atts, r._urls)}
        ${r.project_id ? `<div class="cm-tag"><span class="cm-chip">&#128204; ${esc(jobLabel(S.projects[r.project_id]))}</span></div>` : ''}
        ${status}
      </div>
    </div>`;
  }

  // Signed links run out after an hour: refresh any that are missing.
  async function fillImages(el) {
    const missing = [...el.querySelectorAll('img[data-path]')].filter(i => !i.getAttribute('src') && i.dataset.path);
    if (!missing.length) return;
    await signUrls([{ attachments: missing.map(i => ({ path: i.dataset.path })) }]);
    missing.forEach(i => { const u = S.urls[i.dataset.path]; if (u) i.src = u.url; });
  }

  function wireMessages(el) {
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); onAction(b.dataset.act, b.dataset.id, b, b.dataset.cid); }));
    el.querySelectorAll('.cm-imgs img').forEach(img => img.addEventListener('click', () => {
      const all = [...img.parentElement.querySelectorAll('img')];
      openPhotoLightbox(all.map(i => i.src), all.indexOf(img));
    }));
    // Long press on a phone opens the message menu.
    el.querySelectorAll('.cm[data-id]').forEach(row => {
      let t = null;
      row.addEventListener('touchstart', () => { t = setTimeout(() => { const b = row.querySelector('.cm-more'); if (b) onAction('menu', row.dataset.id, b); }, 550); }, { passive: true });
      ['touchend', 'touchmove', 'touchcancel'].forEach(ev => row.addEventListener(ev, () => clearTimeout(t), { passive: true }));
    });
  }

  function findMsg(id) { return S.messages.find(m => m.id === id) || S.threadMsgs.find(m => m.id === id) || (S.threadRoot && S.threadRoot.id === id ? S.threadRoot : null); }

  function flashMessage(id) {
    const row = document.querySelector(`.cm[data-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
  }

  async function loadOlder() {
    if (!S.current || !S.messages.length) return;
    const older = await fetchMessages(S.current.id, S.messages[0].created_at);
    S.hasOlder = older.length === PAGE;
    await prepare(older);
    S.messages = older.concat(S.messages);
    renderMessages('top');
  }

  let readTimer = null;
  function markRead() {
    if (!S.current || document.hidden) return;
    const id = S.current.id;
    clearTimeout(readTimer);
    readTimer = setTimeout(async () => {
      await supabaseClient.rpc('chat_mark_read', { p_channel: id });
      const c = chanById(id);
      if (c) { c.unread = 0; c.mention_unread = 0; renderList(); }
      refreshChatBadge();
    }, 400);
  }

  async function toggleMute() {
    const c = S.current; if (!c) return;
    const { error } = await supabaseClient.rpc('chat_set_muted', { p_channel: c.id, p_muted: !c.muted });
    if (error) { toast(error.message); return; }
    c.muted = !c.muted;
    const b = document.getElementById('ch-mute');
    if (b) { b.innerHTML = c.muted ? '&#128263;' : '&#128276;'; b.title = c.muted ? 'Unmute' : 'Mute'; }
    renderList();
  }

  // ---------- threads ----------
  async function openThread(rootId, opts = {}) {
    const root = findMsg(rootId) || (await supabaseClient.from('chat_messages').select('*').eq('id', rootId).maybeSingle()).data;
    if (!root) return;
    const wasOpen = !!S.threadRoot;
    S.threadRoot = root;
    const { data } = await supabaseClient.from('chat_messages').select('*').eq('parent_id', rootId).order('created_at').limit(300);
    S.threadMsgs = data || [];
    await prepare([root, ...S.threadMsgs]);
    app.classList.add('thread-open', 'show-thread');
    const el = document.getElementById('ch-thread');
    el.innerHTML = `
      <div class="ch-head">
        <button type="button" class="ch-back" id="th-back" aria-label="Back">&#8249;</button>
        <div class="ch-title"><b>Thread</b><span>${esc(chanTitle(S.current))}</span></div>
        <button type="button" class="secondary" id="th-close" title="Close">&times;</button>
      </div>
      <div class="ch-msgs" id="th-msgs"></div>
      <div id="th-composer"></div>`;
    document.getElementById('th-back').addEventListener('click', () => goBack(() => closeThread()));
    document.getElementById('th-close').addEventListener('click', () => goBack(() => closeThread()));
    mountComposer(document.getElementById('th-composer'), { channelId: root.channel_id, parentId: root.id, placeholder: 'Reply in thread' });
    renderThread();
    if (opts.messageId) flashMessage(opts.messageId);
    if (!opts.keepUrl) setUrl(`/chat.html?c=${root.channel_id}&t=${root.id}`, !wasOpen);
  }
  function renderThread() {
    const el = document.getElementById('th-msgs');
    if (!el || !S.threadRoot) return;
    const key = S.threadRoot.channel_id + ':' + S.threadRoot.id;
    el.innerHTML = msgHtml(S.threadRoot, { compact: false, inThread: true })
      + `<div class="ch-day"><span>${S.threadMsgs.length} ${S.threadMsgs.length === 1 ? 'reply' : 'replies'}</span></div>`
      + listHtml(S.threadMsgs, true)
      + pendingFor(S.threadRoot.channel_id, S.threadRoot.id).map(pendingHtml).join('')
      + (S.botWaiting[key] ? `<div class="cm-bot-typing">${esc(S.botName)} is looking into it...</div>` : '');
    wireMessages(el);
    el.scrollTop = el.scrollHeight;
    fillImages(el);
  }
  function closeThread(silent) {
    S.threadRoot = null; S.threadMsgs = [];
    app.classList.remove('thread-open', 'show-thread');
    document.getElementById('ch-thread').innerHTML = '';
    if (!silent && S.current) history.replaceState(history.state, '', `/chat.html?c=${S.current.id}`);
  }

  // ---------- message actions ----------
  function closeMenu() { const m = document.querySelector('.cm-menu'); if (m) m.remove(); }
  document.addEventListener('click', closeMenu);

  async function onAction(act, id, btn, cid) {
    const m = id ? findMsg(id) : null;
    if (act === 'thread') return openThread(id);
    if (act === 'menu') return showMenu(m, btn);
    if (act === 'untag') { const { error } = await supabaseClient.rpc('chat_set_tag', { p_id: id, p_project: null }); if (error) toast(error.message); return; }
    if (act === 'yes' || act === 'no') { const { error } = await supabaseClient.rpc('chat_answer_suggestion', { p_id: id, p_accept: act === 'yes' }); if (error) toast(error.message); return; }
    if (act === 'retry' || act === 'discard') {
      const r = S.outbox.find(x => x.client_id === cid); if (!r) return;
      if (act === 'discard') { if (!confirm('Delete this unsent message?')) return; await outboxDel(cid); S.outbox = S.outbox.filter(x => x !== r); }
      else { r.status = 'pending'; r.error = null; await outboxPut(stripLocal(r)); flush(); }
      rerenderOpen();
    }
  }

  function showMenu(m, btn) {
    closeMenu();
    if (!m) return;
    const mine = m.author_id === S.me && !m.is_bot;
    const menu = document.createElement('div');
    menu.className = 'cm-menu';
    const items = [];
    if (!m.parent_id && !(S.threadRoot && S.threadRoot.id === m.id)) items.push(['thread', 'Reply in thread']);
    items.push(['tag', m.project_id ? 'Change job tag' : 'Tag a job']);
    if (m.project_id) items.push(['untag', 'Remove job tag']);
    if (m.body) items.push(['copy', 'Copy text']);
    if (mine && m.body) items.push(['edit', 'Edit']);
    if (mine || S.isAdmin) items.push(['delete', 'Delete']);
    menu.innerHTML = items.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === 'delete' ? 'danger' : ''}">${l}</button>`).join('');
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - h - 8)) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    menu.addEventListener('click', async (e) => {
      e.stopPropagation();
      const k = e.target.dataset.k; if (!k) return;
      closeMenu();
      if (k === 'thread') openThread(m.id);
      else if (k === 'tag') jobPicker(async (p) => { const { error } = await supabaseClient.rpc('chat_set_tag', { p_id: m.id, p_project: p.id }); if (error) toast(error.message); });
      else if (k === 'untag') { const { error } = await supabaseClient.rpc('chat_set_tag', { p_id: m.id, p_project: null }); if (error) toast(error.message); }
      else if (k === 'copy') { try { await navigator.clipboard.writeText(m.body); } catch (err) { prompt('Copy this:', m.body); } }
      else if (k === 'edit') {
        const body = prompt('Edit your message', m.body);
        if (body == null || body.trim() === m.body.trim()) return;
        const { error } = await supabaseClient.rpc('chat_edit_message', { p_id: m.id, p_body: body.trim() });
        if (error) toast(error.message);
      } else if (k === 'delete') {
        if (!confirm('Delete this message for everyone?')) return;
        const { data: atts, error } = await supabaseClient.rpc('chat_delete_message', { p_id: m.id });
        if (error) { toast(error.message); return; }
        const paths = (atts || []).map(a => a.path).filter(Boolean);
        if (paths.length && m.author_id === S.me) supabaseClient.storage.from('chat').remove(paths).then(() => {}, () => {});
      }
    });
  }

  // ---------- modals ----------
  function modal(title, bodyHtml, footHtml) {
    const bg = document.createElement('div');
    bg.className = 'ch-modal-bg';
    bg.innerHTML = `<div class="ch-modal"><div class="ch-modal-head"><h3>${esc(title)}</h3><button type="button" class="cc-x" data-close>&times;</button></div>
      <div class="ch-modal-body">${bodyHtml}</div>${footHtml ? `<div class="ch-modal-foot">${footHtml}</div>` : ''}</div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-close')) close(); });
    return { el: bg, close };
  }

  async function searchJobs(q) {
    q = (q || '').trim();
    let query = supabaseClient.from('projects').select('id, name, job_number, quote_number, client_name').neq('pipeline_stage', 'archived');
    const num = q.replace(/^[#jJqQ]\s*/, '');
    if (/^\d+$/.test(num)) query = query.or(`job_number.eq.${num},quote_number.eq.${num}`);
    else if (q) { const safe = q.replace(/[%,()]/g, ' '); query = query.or(`name.ilike.%${safe}%,client_name.ilike.%${safe}%`); }
    const { data } = await query.order('created_at', { ascending: false }).limit(10);
    (data || []).forEach(p => { S.projects[p.id] = p; });
    return (data || []).filter(p => p.job_number || p.quote_number);
  }

  function jobPicker(onPick) {
    const md = modal('Tag a job', `<input type="search" id="jp-q" placeholder="J number, Q number, job or client name" autocomplete="off" /><div id="jp-res" style="margin-top:8px;"></div>`);
    const input = md.el.querySelector('#jp-q');
    const res = md.el.querySelector('#jp-res');
    let t = null;
    const run = async () => {
      const list = await searchJobs(input.value);
      res.innerHTML = list.length ? list.map(p => `<button type="button" class="ch-result" data-id="${p.id}"><b>${esc(jobLabel(p))}</b> <small style="color:var(--muted);">${esc(p.client_name || '')}</small></button>`).join('') : '<p class="subtitle">No matching jobs.</p>';
      res.querySelectorAll('.ch-result').forEach(b => b.addEventListener('click', () => { md.close(); onPick(S.projects[b.dataset.id]); }));
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
    run(); input.focus();
  }

  function peoplePicker(selected, opts = {}) {
    return `<input type="search" class="pp-q" placeholder="Search people" autocomplete="off" style="margin-bottom:8px;" />
      <div class="pp-list">${S.staff.filter(s => opts.includeMe || s.id !== S.me).map(s => `<label class="ch-pick" data-name="${esc((s.full_name || '').toLowerCase())}"><input type="checkbox" value="${s.id}" ${selected.includes(s.id) ? 'checked' : ''} /> ${avatar(s, false)} ${esc(s.full_name || 'Unnamed')}</label>`).join('')}</div>`;
  }
  function wirePeoplePicker(root) {
    const q = root.querySelector('.pp-q');
    q.addEventListener('input', () => {
      const v = q.value.trim().toLowerCase();
      root.querySelectorAll('.pp-list .ch-pick').forEach(l => { l.style.display = !v || l.dataset.name.includes(v) ? '' : 'none'; });
    });
    return () => [...root.querySelectorAll('.pp-list input:checked')].map(i => i.value);
  }

  function newDmModal() {
    const md = modal('New message', `<p class="subtitle" style="margin:0 0 8px;">Pick one person, or a few for a group message.</p>${peoplePicker([])}`,
      `<button type="button" class="secondary" data-close>Cancel</button><button type="button" id="dm-go">Start chat</button>`);
    const picked = wirePeoplePicker(md.el);
    md.el.querySelector('#dm-go').addEventListener('click', async () => {
      const ids = picked();
      if (!ids.length) { toast('Pick at least one person.'); return; }
      const { data: id, error } = await supabaseClient.rpc('chat_open_dm', { p_member_ids: ids });
      if (error) { toast(error.message); return; }
      md.close();
      await loadChannels();
      openChannel(id);
    });
  }

  async function channelModal(c) {
    let members = [];
    if (c && !c.everyone) {
      const { data } = await supabaseClient.from('chat_members').select('profile_id').eq('channel_id', c.id);
      members = (data || []).map(r => r.profile_id);
    }
    const system = c && c.slug;
    const md = modal(c ? 'Channel settings' : 'New channel', `
      <label style="margin-top:0;">Name</label><input id="cm-name" value="${esc(c ? c.name : '')}" placeholder="e.g. Solar crew" ${system ? 'disabled' : ''} />
      <label>What it's for (optional)</label><input id="cm-desc" value="${esc(c ? c.description || '' : '')}" />
      <label class="ch-pick" style="margin-top:12px;"><input type="checkbox" id="cm-everyone" ${!c || c.everyone ? 'checked' : ''} ${system ? 'disabled' : ''} /> Everyone (all staff, including new starters)</label>
      <div id="cm-people" style="display:${!c || c.everyone ? 'none' : 'block'}; margin-top:6px;">${peoplePicker(members, { includeMe: true })}</div>
      ${c && !system ? `<label class="ch-pick" style="margin-top:12px;"><input type="checkbox" id="cm-archive" ${c.archived_at ? 'checked' : ''} /> Archived (hidden, read only)</label>` : ''}`,
      `<button type="button" class="secondary" data-close>Cancel</button><button type="button" id="cm-save">${c ? 'Save' : 'Make channel'}</button>`);
    const picked = wirePeoplePicker(md.el);
    const every = md.el.querySelector('#cm-everyone');
    every.addEventListener('change', () => { md.el.querySelector('#cm-people').style.display = every.checked ? 'none' : 'block'; });
    md.el.querySelector('#cm-save').addEventListener('click', async () => {
      const name = md.el.querySelector('#cm-name').value.trim();
      const desc = md.el.querySelector('#cm-desc').value.trim();
      const ids = picked();
      let res;
      if (c) {
        const arch = md.el.querySelector('#cm-archive');
        res = await supabaseClient.rpc('chat_update_channel', { p_channel: c.id, p_name: name || c.name, p_description: desc, p_archived: !!(arch && arch.checked), p_everyone: every.checked, p_member_ids: ids });
      } else {
        res = await supabaseClient.rpc('chat_create_channel', { p_name: name, p_description: desc, p_everyone: every.checked, p_member_ids: ids });
      }
      if (res.error) { toast(res.error.message); return; }
      md.close();
      await loadChannels();
      openChannel(c ? c.id : res.data);
    });
  }

  // ---------- composer ----------
  function mountComposer(el, ctx) {
    const state = { files: [], projectId: null, mentions: {}, rec: null };
    el.innerHTML = `<div class="cc">
      <div class="cc-pop" style="display:none;"></div>
      <div class="cc-chips"></div>
      <div class="cc-recbar" style="display:none;"></div>
      <div class="cc-row" data-wh-anchor>
        <button type="button" class="cc-icon cc-attach" title="Photo or file">&#128206;</button>
        <input type="file" class="cc-file-input" multiple style="display:none;" />
        <button type="button" class="cc-icon cc-job" title="Tag a job">#</button>
        <textarea rows="1" placeholder="${esc(ctx.placeholder)}"></textarea>
        <button type="button" class="cc-icon cc-mic" title="Voice message">&#127908;</button>
        <button type="button" class="cc-send">Send</button>
      </div>
    </div>`;
    const ta = el.querySelector('textarea');
    const pop = el.querySelector('.cc-pop');
    const chips = el.querySelector('.cc-chips');
    const fileInput = el.querySelector('.cc-file-input');
    const draftKey = `te-chat-draft:${ctx.channelId}:${ctx.parentId || ''}`;
    try { ta.value = localStorage.getItem(draftKey) || ''; } catch (e) { /* private mode */ }

    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
    const renderChips = () => {
      chips.innerHTML = (state.projectId ? `<span class="cm-chip">&#128204; ${esc(jobLabel(S.projects[state.projectId]))} <button type="button" class="cc-x" data-x="job">&times;</button></span>` : '')
        + state.files.map((f, i) => `<span class="cc-file">${f.kind === 'image' ? `<img src="${f.preview}" alt="" />` : (f.kind === 'voice' ? '&#127908;' : '&#128206;')}<span>${esc(f.name)}</span><button type="button" class="cc-x" data-x="${i}">&times;</button></span>`).join('');
      chips.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.x === 'job') state.projectId = null; else state.files.splice(Number(b.dataset.x), 1);
        renderChips();
      }));
    };

    // @ people and # jobs while typing.
    let popItems = [], popSel = 0, popToken = null, popTimer = null;
    const hidePop = () => { pop.style.display = 'none'; popItems = []; popToken = null; };
    const showPop = () => {
      if (!popItems.length) { hidePop(); return; }
      pop.innerHTML = popItems.map((it, i) => `<button type="button" class="${i === popSel ? 'sel' : ''}" data-i="${i}">${it.html}</button>`).join('');
      pop.style.display = 'block';
      pop.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', (e) => { e.preventDefault(); choose(Number(b.dataset.i)); }));
    };
    const choose = (i) => {
      const it = popItems[i]; if (!it || !popToken) return;
      const before = ta.value.slice(0, popToken.start), after = ta.value.slice(ta.selectionEnd);
      let insert = '';
      if (it.person) { insert = `@${it.person.full_name} `; state.mentions[it.person.full_name] = it.person.id; }
      else if (it.bot) insert = `@${S.botName} `;
      else if (it.job) { state.projectId = it.job.id; renderChips(); }
      ta.value = before + insert + after;
      const pos = before.length + insert.length;
      ta.setSelectionRange(pos, pos); ta.focus();
      hidePop(); grow(); saveDraft();
    };
    const onType = () => {
      grow(); saveDraft();
      const upto = ta.value.slice(0, ta.selectionStart);
      const m = upto.match(/(^|\s)([@#])([^\s@#]{0,30})$/);
      if (!m) { hidePop(); return; }
      popToken = { kind: m[2], start: upto.length - m[3].length - 1 };
      const q = m[3].toLowerCase();
      popSel = 0;
      if (m[2] === '@') {
        const people = S.staff.filter(s => s.id !== S.me && (s.full_name || '').toLowerCase().split(/\s+/).some(w => w.startsWith(q)) || (q.length > 1 && (s.full_name || '').toLowerCase().includes(q))).slice(0, 8);
        popItems = [];
        if (S.botName.toLowerCase().startsWith(q)) popItems.push({ bot: true, html: `&#129302; <b>${esc(S.botName)}</b> <small>AI, answers questions</small>` });
        people.forEach(p => popItems.push({ person: p, html: `${avatar(p, false).replace('cm-avatar', 'cm-avatar" style="width:24px;height:24px;font-size:10px')} ${esc(p.full_name)}` }));
        showPop();
      } else {
        clearTimeout(popTimer);
        popTimer = setTimeout(async () => {
          const jobs = await searchJobs(q);
          if (!popToken || popToken.kind !== '#') return;
          popItems = jobs.map(j => ({ job: j, html: `&#128204; <b>${esc(jobLabel(j))}</b> <small>${esc(j.client_name || '')}</small>` }));
          showPop();
        }, 200);
      }
    };
    const saveDraft = () => { try { if (ta.value) localStorage.setItem(draftKey, ta.value); else localStorage.removeItem(draftKey); } catch (e) { /* private mode */ } };
    ta.addEventListener('input', onType);
    ta.addEventListener('blur', () => setTimeout(hidePop, 150));
    ta.addEventListener('keydown', (e) => {
      if (pop.style.display === 'block' && popItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); popSel = (popSel + 1) % popItems.length; showPop(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); popSel = (popSel - 1 + popItems.length) % popItems.length; showPop(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(popSel); return; }
        if (e.key === 'Escape') { hidePop(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); send(); }
    });
    el.querySelector('.cc-job').addEventListener('click', () => {
      jobPicker((p) => { state.projectId = p.id; renderChips(); });
    });

    // Photos and files: photos are shrunk before they are queued.
    el.querySelector('.cc-attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const f of [...fileInput.files]) {
        if (f.size > 50 * 1048576) { toast(`${f.name} is over 50 MB, too big to send.`); continue; }
        const isImg = f.type.startsWith('image/') && !/heic|heif/i.test(f.type);
        const out = isImg ? await compressImage(f) : f;
        state.files.push({ blob: out, name: out.name || f.name, type: out.type || f.type || 'application/octet-stream', size: out.size, kind: isImg ? 'image' : 'file', preview: isImg ? URL.createObjectURL(out) : null });
      }
      fileInput.value = '';
      renderChips();
    });

    // Voice: tap the mic to record, tap Send (or the mic) to send it.
    const mic = el.querySelector('.cc-mic');
    const recbar = el.querySelector('.cc-recbar');
    const stopRec = (keep) => new Promise((resolve) => {
      const r = state.rec; if (!r) return resolve(null);
      clearInterval(r.timer);
      r.recorder.onstop = () => {
        r.stream.getTracks().forEach(t => t.stop());
        state.rec = null; mic.classList.remove('on'); recbar.style.display = 'none';
        if (!keep) return resolve(null);
        const type = r.recorder.mimeType || r.type || 'audio/webm';
        const blob = new Blob(r.chunks, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        resolve({ blob, name: `Voice message.${ext}`, type, size: blob.size, kind: 'voice', duration: Math.round((Date.now() - r.started) / 1000) });
      };
      try { r.recorder.stop(); } catch (e) { resolve(null); }
    });
    mic.addEventListener('click', async () => {
      if (state.rec) { const v = await stopRec(true); if (v) { state.files.push(v); send(); } return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This device cannot record voice messages here.'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
        const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        const r = { stream, recorder, type, chunks: [], started: Date.now() };
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
        recorder.start(1000);
        state.rec = r;
        mic.classList.add('on');
        recbar.style.display = 'block';
        const tick = () => {
          const s = Math.round((Date.now() - r.started) / 1000);
          recbar.innerHTML = `<div class="cc-rec"><span class="dot"></span> Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} <button type="button" class="secondary" data-rec="cancel" style="padding:4px 10px; font-size:12px;">Cancel</button> <span class="cm-time">Tap Send when done</span></div>`;
          recbar.querySelector('[data-rec="cancel"]').onclick = () => stopRec(false);
          if (s >= 300) stopRec(true).then(v => { if (v) { state.files.push(v); send(); } });
        };
        tick(); r.timer = setInterval(tick, 1000);
      } catch (err) {
        toast('Could not use the microphone. Allow microphone access for this app in your phone or browser settings.');
      }
    });

    let sending = false;
    async function send() {
      if (sending) return;
      sending = true;
      try { await sendNow(); } finally { sending = false; }
    }
    async function sendNow() {
      if (state.rec) { const v = await stopRec(true); if (v) state.files.push(v); }
      // spelling fixed first (js/writing-help.js), at most a second and a half
      if (window.teWriting && ta.value.trim()) await window.teWriting.beforeSend(ta);
      const body = ta.value.trim();
      if (!body && !state.files.length) return;
      const mentionIds = S.staff.filter(s => s.full_name && body.includes('@' + s.full_name)).map(s => s.id);
      const asksBot = botRegex().test(body);
      const rec = {
        client_id: crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2),
        author_id: S.me, channel_id: ctx.channelId, parent_id: ctx.parentId || null,
        body, mention_ids: mentionIds, project_id: state.projectId,
        created_at: new Date().toISOString(), status: 'pending', asks_bot: asksBot,
        files: state.files.map(({ blob, name, type, size, kind, duration }) => ({ blob, name, type, size, kind, duration })),
      };
      ta.value = ''; saveDraft(); grow();
      state.files = []; state.projectId = null; state.mentions = {};
      renderChips();
      try { await outboxPut(rec); } catch (e) { /* IndexedDB blocked: still try to send from memory */ }
      S.outbox.push(rec);
      rerenderOpen();
      flush();
    }
    el.querySelector('.cc-send').addEventListener('click', send);
    grow();
    if (!isTouch()) ta.focus();
  }

  // ---------- sending ----------
  const stripLocal = (r) => { const { _urls, ...rest } = r; return rest; };
  const isNetworkError = (err) => !navigator.onLine || /fetch|network|load failed|timed? ?out|aborted/i.test((err && (err.message || err.error || '')) + '');
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    const sentIds = [];
    try {
      for (const rec of [...S.outbox]) {
        if (rec.status === 'failed') continue;
        try {
          const attachments = [];
          for (let i = 0; i < (rec.files || []).length; i++) {
            const f = rec.files[i];
            const safe = (f.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
            const path = `${rec.channel_id}/${rec.client_id}-${i}-${safe}`;
            const { error } = await supabaseClient.storage.from('chat').upload(path, f.blob, { contentType: f.type, upsert: false });
            if (error && !/exists|duplicate/i.test(error.message || '')) throw error;
            attachments.push({ path, name: f.name, type: f.type, size: f.size, kind: f.kind, ...(f.duration ? { duration: f.duration } : {}) });
          }
          let { data: row, error } = await supabaseClient.from('chat_messages').insert({
            client_id: rec.client_id, channel_id: rec.channel_id, parent_id: rec.parent_id, author_id: S.me,
            body: rec.body, attachments, mention_ids: rec.mention_ids, project_id: rec.project_id, created_at: rec.created_at,
          }).select('*').single();
          if (error && error.code === '23505') ({ data: row, error } = await supabaseClient.from('chat_messages').select('*').eq('client_id', rec.client_id).single());
          if (error) throw error;
          await outboxDel(rec.client_id).catch(() => {});
          (rec._urls || []).forEach(u => URL.revokeObjectURL(u));
          S.outbox = S.outbox.filter(x => x !== rec);
          if (rec.asks_bot) S.botWaiting[rec.channel_id + ':' + (rec.parent_id || '')] = Date.now();
          await prepare([row]);
          upsertMessage(row);
          sentIds.push(row.id);
        } catch (err) {
          if (isNetworkError(err)) break;
          rec.status = 'failed'; rec.error = err.message || String(err);
          await outboxPut(stripLocal(rec)).catch(() => {});
          rerenderOpen();
        }
      }
    } finally {
      flushing = false;
    }
    if (sentIds.length) {
      const t = await token();
      fetch('/.netlify/functions/chat-after-send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ message_ids: sentIds }) }).catch(() => {});
    }
    document.getElementById('ch-offline').style.display = S.outbox.some(r => r.status !== 'failed') && !navigator.onLine ? 'block' : 'none';
  }

  function rerenderOpen() {
    if (S.current) renderMessages();
    if (S.threadRoot) renderThread();
  }

  // ---------- live updates ----------
  function upsertMessage(row) {
    S.outbox = S.outbox.filter(r => r.client_id !== row.client_id || !row.client_id);
    if (row.is_bot) {
      const key = row.channel_id + ':' + (row.parent_id || '');
      delete S.botWaiting[key];
    }
    // Chat list summary
    const c = chanById(row.channel_id);
    if (c) {
      c.last_message_at = row.created_at > (c.last_message_at || '') ? row.created_at : c.last_message_at;
      if (!row.parent_id) { c.last_body = row.body || (row.attachments && row.attachments.length ? (row.attachments[0].kind === 'voice' ? 'Voice message' : row.attachments[0].kind === 'image' ? 'Photo' : 'File') : ''); c.last_author = row.is_bot ? null : (S.staffById[row.author_id] || {}).full_name; c.last_is_bot = row.is_bot; }
      S.channels.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
    }
    if (S.current && row.channel_id === S.current.id) {
      if (!row.parent_id) {
        const i = S.messages.findIndex(m => m.id === row.id);
        if (i >= 0) S.messages[i] = row; else { S.messages.push(row); S.messages.sort((a, b) => a.created_at.localeCompare(b.created_at)); }
      }
      // A reply only changes its parent's reply count, which arrives as the parent's own update.
      if (!row.parent_id) {
        const el = document.getElementById('ch-msgs');
        const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        renderMessages(nearBottom || row.author_id === S.me ? undefined : 'stay');
      }
    }
    if (S.threadRoot && (row.parent_id === S.threadRoot.id || row.id === S.threadRoot.id)) {
      if (row.id === S.threadRoot.id) S.threadRoot = row;
      else {
        const i = S.threadMsgs.findIndex(m => m.id === row.id);
        if (i >= 0) S.threadMsgs[i] = row; else S.threadMsgs.push(row);
      }
      renderThread();
    }
    renderList();
  }

  async function onInsert(row) {
    if (!chanById(row.channel_id)) { await loadChannels(); }
    await prepare([row]);
    const c = chanById(row.channel_id);
    const viewing = S.current && S.current.id === row.channel_id && !document.hidden;
    if (c && row.author_id !== S.me && !viewing && !(row.parent_id && !(row.mention_ids || []).includes(S.me))) {
      c.unread = (c.unread || 0) + 1;
      if ((row.mention_ids || []).includes(S.me)) c.mention_unread = (c.mention_unread || 0) + 1;
    }
    upsertMessage(row);
    if (viewing) markRead();
    refreshChatBadge();
  }
  async function onUpdate(row) {
    await prepare([row]);
    if (findMsg(row.id)) upsertMessage(row);
  }

  function subscribe() {
    try {
      supabaseClient.channel('chat-page-' + S.me)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (p) => onInsert(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (p) => onUpdate(p.new))
        .subscribe();
    } catch (e) { /* the refresh on focus still keeps it current */ }
  }

  // Coming back to the app (or getting signal back): catch up.
  async function catchUp() {
    await loadChannels();
    if (S.current) {
      const fresh = await fetchMessages(S.current.id).catch(() => null);
      if (fresh) {
        const ids = new Set(fresh.map(m => m.id));
        S.messages = S.messages.filter(m => !ids.has(m.id) && m.created_at < (fresh[0] ? fresh[0].created_at : '')).concat(fresh);
        await prepare(fresh);
        renderMessages();
        markRead();
      }
    }
    if (S.threadRoot) openThread(S.threadRoot.id, { keepUrl: true });
    flush();
  }

  // Keeps the page the height of the visible screen (iPhone keyboard).
  function fitHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--ch-vh', h + 'px');
    if (window.visualViewport && isPhone()) window.scrollTo(0, 0);
  }

  // ---------- start ----------
  (async function init() {
    const session = await requireLogin();
    if (!session) return;
    S.me = session.user.id;
    syncThemeFromProfile();
    renderMainNav('chat');
    document.getElementById('logout-link').addEventListener('click', async (e) => {
      e.preventDefault();
      await supabaseClient.auth.signOut();
      window.location.href = '/login.html';
    });
    fitHeight();
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitHeight);
    window.addEventListener('resize', fitHeight);

    S.role = await getMyRole();
    S.isAdmin = S.role === 'admin';
    if (S.isAdmin) document.getElementById('ch-new-channel').style.display = '';
    S.botName = (typeof aiAssistantName === 'function' && aiAssistantName()) || 'Sparky';
    await Promise.all([
      loadStaff(),
      supabaseClient.from('company_settings').select('ai_assistant_name').eq('id', 1).maybeSingle().then(r => { if (r.data && r.data.ai_assistant_name && r.data.ai_assistant_name.trim()) S.botName = r.data.ai_assistant_name.trim(); }),
    ]);
    try { S.outbox = await outboxAll(); S.outbox.forEach(r => { if (r.status === 'failed') return; r.status = 'pending'; }); } catch (e) { S.outbox = []; }
    await loadProjects(S.outbox.map(r => r.project_id));
    await loadChannels();

    document.getElementById('ch-new-dm').addEventListener('click', newDmModal);
    document.getElementById('ch-new-channel').addEventListener('click', () => channelModal(null));
    document.getElementById('ch-filter').addEventListener('input', (e) => { S.filter = e.target.value; renderList(); });

    subscribe();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp(); });
    window.addEventListener('online', () => { document.getElementById('ch-offline').style.display = 'none'; flush(); rerenderOpen(); });
    window.addEventListener('offline', () => { if (S.outbox.length) document.getElementById('ch-offline').style.display = 'block'; rerenderOpen(); });
    setInterval(() => { if (S.outbox.some(r => r.status !== 'failed')) flush(); }, 20000);
    setInterval(() => {
      // Sparky normally answers within a minute; stop showing "looking into it" after 3.
      let changed = false;
      for (const k of Object.keys(S.botWaiting)) if (Date.now() - S.botWaiting[k] > 180000) { delete S.botWaiting[k]; changed = true; }
      if (changed) rerenderOpen();
    }, 30000);

    const params = new URLSearchParams(location.search);
    const c = params.get('c');
    if (c && isPhone()) {
      // Opened from a link or notification: put the list behind it so back lands there.
      history.replaceState(null, '', '/chat.html');
      await openChannel(c, { messageId: params.get('t') ? null : params.get('m') });
      if (params.get('t')) await openThread(params.get('t'), { messageId: params.get('m') });
    } else if (c) {
      await openChannel(c, { messageId: params.get('t') ? null : params.get('m'), keepUrl: true });
      if (params.get('t')) await openThread(params.get('t'), { messageId: params.get('m') });
    } else if (!isPhone()) {
      const general = S.channels.find(x => x.slug === 'general');
      if (general) openChannel(general.id);
    }
    flush();
  })();
})();
