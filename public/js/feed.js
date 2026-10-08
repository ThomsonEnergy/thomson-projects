// The company feed, shared by the Home page (everyone's posts, plus any job
// post ticked "also show on Home") and each job/quote's Feed tab (just that
// job's posts). Posts can be liked and commented on; a post can tag people,
// who then get a notification on their Home page (feed_mentions) until they
// open it. Needs supabase-client.js loaded first.

let _feedStaffCache = null;
async function feedStaff() {
  if (!_feedStaffCache) {
    const { data } = await supabaseClient.from('profiles').select('id, full_name').eq('active', true).order('full_name');
    _feedStaffCache = data || [];
  }
  return _feedStaffCache;
}

// Feed styling lives here (not in each page) so Home and every job look the
// same. Name / time / message are three clearly different things: bold name,
// small muted time, then the text itself; comments are speech-bubble style
// under a post with their own avatar.
function ensureFeedStyles() {
  if (document.getElementById('feed-styles')) return;
  const st = document.createElement('style');
  st.id = 'feed-styles';
  st.textContent = `
    .fd-card { border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin-bottom:14px; background:var(--surface); }
    .fd-head { display:flex; gap:12px; align-items:flex-start; }
    .fd-avatar { width:38px; height:38px; flex:none; border-radius:50%; color:#fff; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:center; }
    .fd-avatar.sm { width:30px; height:30px; font-size:12px; margin-top:2px; }
    img.fd-avatar { display:block; object-fit:contain; background:var(--surface-2); }
    .fd-who { flex:1; min-width:0; }
    .fd-name { font-weight:700; font-size:14px; color:var(--text); }
    .fd-time { font-size:12px; color:var(--muted); }
    .fd-pill { display:inline-block; background:var(--accent-dim); color:var(--accent); padding:2px 9px; border-radius:999px; font-weight:600; font-size:12px; text-decoration:none; }
    .fd-body { color:var(--text); margin:10px 0 0; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
    .fd-tags { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px; color:var(--muted); }
    .fd-actions { display:flex; gap:4px; margin-top:12px; padding-top:8px; border-top:1px solid var(--border); }
    .fd-actions button, .fd-delete { background:none; border:none; color:var(--muted); cursor:pointer; font-size:13px; padding:5px 10px; border-radius:6px; width:auto; }
    .fd-actions button:hover, .fd-delete:hover { background:var(--surface-2); color:var(--text); }
    .fd-actions button.liked { color:var(--accent); font-weight:700; }
    .fd-delete { font-size:12px; flex:none; }
    .fd-comments { margin-top:12px; display:flex; flex-direction:column; gap:10px; }
    .fd-comment { display:flex; gap:10px; align-items:flex-start; }
    .fd-bubble { background:var(--surface-2); border:1px solid var(--border); border-radius:4px 14px 14px 14px; padding:8px 12px; min-width:0; flex:1; max-width:680px; }
    .fd-bubble-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; margin-bottom:3px; }
    .fd-bubble-text { color:var(--text); line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
    .fd-comment-form { display:flex; gap:8px; align-items:center; }
    .fd-comment-form input { flex:1; margin:0; border-radius:999px; padding-left:14px; }
    .fd-comment-form button { margin:0; white-space:nowrap; }
    .fd-tag-panel { padding:10px; border:1px solid var(--border); border-radius:8px; max-height:160px; overflow-y:auto; }
  `;
  document.head.appendChild(st);
}
function feedInitials(name) {
  return (String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase();
}
function feedAvatarColour(name) {
  let h = 0;
  String(name || '').split('').forEach(ch => { h = (h * 31 + ch.charCodeAt(0)) % 360; });
  return `hsl(${h}, 45%, 42%)`;
}
// The person's profile photo when they have one, otherwise a coloured circle
// with their initials (also what shows if the photo fails to load).
function feedAvatar(name, small, photoUrl) {
  const cls = `fd-avatar${small ? ' sm' : ''}`;
  const initials = `<div class="${cls}" style="background:${feedAvatarColour(name)};${photoUrl ? 'display:none;' : ''}" aria-hidden="true">${escapeHtml(feedInitials(name))}</div>`;
  if (!photoUrl) return initials;
  const src = typeof supaImageVariant === 'function' ? supaImageVariant(photoUrl, 120, 80) : photoUrl;
  return `<img class="${cls}" src="${escapeHtml(src)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />${initials}`;
}

function feedWhen(iso) {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// Builds the "write a post" box into `el`. opts: { myUserId, projectId (a job
// feed), onPosted }. A job post has a "also show on the Home page" tick; any
// post can tag people.
async function mountFeedComposer(el, opts) {
  ensureFeedStyles();
  const staff = (await feedStaff()).filter(s => s.id !== opts.myUserId);
  el.innerHTML = `
    <textarea class="feed-new-text" placeholder="${opts.projectId ? 'Write a note about this job...' : 'Post something to the team...'}" style="min-height:70px;"></textarea>
    <div class="feed-tagged" style="margin-top:6px; font-size:12px; color:var(--muted);"></div>
    <div class="feed-tag-panel" style="display:none; margin-top:6px; padding:10px; border:1px solid var(--border); border-radius:8px; max-height:180px; overflow-y:auto;">
      <p class="subtitle" style="margin:0 0 6px; font-size:12px;">They'll get a notification on their Home page.</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:4px 12px;">
        ${staff.map(s => `<label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="checkbox" class="feed-tag-check" value="${s.id}" data-name="${escapeHtml(s.full_name || 'Unnamed')}" style="width:auto;" /> ${escapeHtml(s.full_name || 'Unnamed')}</label>`).join('')}
      </div>
    </div>
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px;">
      <button type="button" class="feed-post-btn">Post</button>
      <button type="button" class="secondary feed-tag-btn" style="font-size:12px; padding:6px 10px;">@ Tag people</button>
      ${opts.projectId ? `<label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400; font-size:13px;"><input type="checkbox" class="feed-home-check" style="width:auto;" /> Also show on the Home page</label>` : ''}
    </div>
    <div class="feed-msg"></div>`;

  const tagPanel = el.querySelector('.feed-tag-panel');
  const taggedEl = el.querySelector('.feed-tagged');
  const refreshTagged = () => {
    const names = [...el.querySelectorAll('.feed-tag-check:checked')].map(c => c.dataset.name);
    taggedEl.textContent = names.length ? `Tagging: ${names.join(', ')}` : '';
  };
  el.querySelector('.feed-tag-btn').addEventListener('click', () => { tagPanel.style.display = tagPanel.style.display === 'none' ? 'block' : 'none'; });
  el.querySelectorAll('.feed-tag-check').forEach(c => c.addEventListener('change', refreshTagged));

  el.querySelector('.feed-post-btn').addEventListener('click', async () => {
    const msgEl = el.querySelector('.feed-msg');
    const textEl = el.querySelector('.feed-new-text');
    const message = textEl.value.trim();
    if (!message) return;
    const btn = el.querySelector('.feed-post-btn');
    btn.disabled = true;
    const homeCheck = el.querySelector('.feed-home-check');
    const { data: post, error } = await supabaseClient.from('feed_posts').insert({
      author_id: opts.myUserId, message,
      project_id: opts.projectId || null,
      show_on_home: opts.projectId ? !!(homeCheck && homeCheck.checked) : true,
    }).select('id').single();
    if (error) { msgEl.innerHTML = `<div class="error-box">${error.message}</div>`; btn.disabled = false; return; }
    const tagged = [...el.querySelectorAll('.feed-tag-check:checked')].map(c => c.value);
    if (tagged.length) {
      const { error: tagErr } = await supabaseClient.from('feed_mentions').insert(tagged.map(pid => ({ post_id: post.id, profile_id: pid })));
      if (tagErr) { msgEl.innerHTML = `<div class="error-box">Posted, but tagging failed: ${tagErr.message}</div>`; }
    }
    textEl.value = '';
    el.querySelectorAll('.feed-tag-check').forEach(c => { c.checked = false; });
    if (homeCheck) homeCheck.checked = false;
    tagPanel.style.display = 'none';
    refreshTagged();
    if (!msgEl.innerHTML) msgEl.innerHTML = '';
    btn.disabled = false;
    if (opts.onPosted) await opts.onPosted();
  });
}

// Renders the posts into `el`. opts: { myUserId, projectId (just this job's
// posts) or none for the Home feed, isAdmin, limit }. Opening a feed marks
// the viewer's tags on the posts shown as seen - on a job's feed that's that
// job's posts, on Home it's the Home-only (non-job) posts, so a job tag stays
// as a notification until the job itself is opened.
async function renderFeedList(el, opts) {
  ensureFeedStyles();
  let q = supabaseClient.from('feed_posts')
    .select('*, profiles(full_name, photo_url), projects(id, name, job_number, quote_number)')
    .order('created_at', { ascending: false }).limit(opts.limit || 30);
  q = opts.projectId ? q.eq('project_id', opts.projectId) : q.or('project_id.is.null,show_on_home.eq.true');
  const { data: posts, error } = await q;
  if (error) { el.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
  if (!posts.length) { el.innerHTML = `<p class="subtitle">${opts.projectId ? 'No notes on this job yet - add the first one above.' : 'No posts yet - be the first.'}</p>`; return; }

  const staff = (await feedStaff()).filter(p => p.id !== opts.myUserId);
  const postIds = posts.map(p => p.id);
  const [{ data: likes }, { data: comments }, { data: mentions }] = await Promise.all([
    supabaseClient.from('feed_likes').select('post_id, author_id').in('post_id', postIds),
    supabaseClient.from('feed_comments').select('*, profiles(full_name, photo_url)').in('post_id', postIds).order('created_at'),
    supabaseClient.from('feed_mentions').select('post_id, comment_id, profile_id, profiles(full_name)').in('post_id', postIds),
  ]);

  const projectRefOf = (p) => (typeof projectRef === 'function' ? projectRef(p) : (p.name || 'Job'));
  const tagLine = (list) => list.length
    ? `<div class="fd-tags">Tagged ${list.map(t => `<span class="fd-pill">@${escapeHtml((t.profiles && t.profiles.full_name) || 'Someone')}</span>`).join('')}</div>` : '';
  el.innerHTML = posts.map(post => {
    const postLikes = (likes || []).filter(l => l.post_id === post.id);
    const iLiked = postLikes.some(l => l.author_id === opts.myUserId);
    const postComments = (comments || []).filter(c => c.post_id === post.id);
    const tagged = (mentions || []).filter(m => m.post_id === post.id && !m.comment_id);
    const mine = post.author_id === opts.myUserId;
    const author = post.profiles ? post.profiles.full_name : 'Someone';
    return `
      <article class="fd-card feed-post" data-post-id="${post.id}">
        <header class="fd-head">
          ${feedAvatar(author, false, post.profiles && post.profiles.photo_url)}
          <div class="fd-who">
            <div class="fd-name">${escapeHtml(author)}${post.projects && !opts.projectId ? ` <a href="/project.html?id=${post.projects.id}&tab=feed" class="fd-pill" style="margin-left:6px;">${escapeHtml(projectRefOf(post.projects))}</a>` : ''}</div>
            <div class="fd-time">${feedWhen(post.created_at)}${post.projects && opts.projectId && post.show_on_home ? ' &middot; also on Home' : ''}</div>
          </div>
          ${(mine || opts.isAdmin) ? `<button type="button" class="fd-delete feed-delete-btn" data-post-id="${post.id}" title="Delete this post">Delete</button>` : ''}
        </header>
        <div class="fd-body">${escapeHtml(post.message)}</div>
        ${tagLine(tagged)}
        <footer class="fd-actions">
          <button type="button" class="feed-like-btn ${iLiked ? 'liked' : ''}" data-post-id="${post.id}" data-liked="${iLiked}">
            &#128077; ${postLikes.length || ''} ${iLiked ? 'Liked' : 'Like'}
          </button>
          <button type="button" class="feed-like-btn toggle-comments-btn" data-post-id="${post.id}">&#128172; Comment${postComments.length ? ' (' + postComments.length + ')' : ''}</button>
        </footer>
        <div class="fd-comments feed-comments" data-post-id="${post.id}" style="${postComments.length && opts.projectId ? '' : 'display:none;'}">
          ${postComments.map(c => {
            const cName = c.profiles ? c.profiles.full_name : 'Someone';
            return `
            <div class="fd-comment feed-comment">
              ${feedAvatar(cName, true, c.profiles && c.profiles.photo_url)}
              <div class="fd-bubble">
                <div class="fd-bubble-head"><span class="fd-name">${escapeHtml(cName)}</span><span class="fd-time">${feedWhen(c.created_at)}</span></div>
                <div class="fd-bubble-text">${escapeHtml(c.message)}</div>
                ${tagLine((mentions || []).filter(m => m.comment_id === c.id))}
              </div>
            </div>`;
          }).join('')}
          <div class="fd-comment-form">
            <input class="new-comment-input" data-post-id="${post.id}" placeholder="Write a comment..." />
            <button type="button" class="secondary comment-tag-btn" data-post-id="${post.id}" title="Tag people in this comment" style="padding:8px 12px;">@</button>
            <button type="button" class="secondary send-comment-btn" data-post-id="${post.id}" style="padding:8px 16px;">Send</button>
          </div>
          <div class="fd-tag-panel comment-tag-panel" data-post-id="${post.id}" style="display:none;">
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:4px 12px;">
              ${staff.map(p => `<label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="checkbox" class="comment-tag-check" data-post-id="${post.id}" value="${p.id}" style="width:auto;" /> ${escapeHtml(p.full_name || 'Unnamed')}</label>`).join('')}
            </div>
          </div>
        </div>
      </article>`;
  }).join('');

  const reload = () => renderFeedList(el, opts);
  el.querySelectorAll('.feed-like-btn[data-liked]').forEach(btn => btn.addEventListener('click', async () => {
    const postId = btn.dataset.postId;
    if (btn.dataset.liked === 'true') await supabaseClient.from('feed_likes').delete().eq('post_id', postId).eq('author_id', opts.myUserId);
    else await supabaseClient.from('feed_likes').insert({ post_id: postId, author_id: opts.myUserId });
    await reload();
  }));
  el.querySelectorAll('.toggle-comments-btn').forEach(btn => btn.addEventListener('click', () => {
    const panel = el.querySelector(`.feed-comments[data-post-id="${btn.dataset.postId}"]`);
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }));
  el.querySelectorAll('.comment-tag-btn').forEach(btn => btn.addEventListener('click', () => {
    const panel = el.querySelector(`.comment-tag-panel[data-post-id="${btn.dataset.postId}"]`);
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }));
  el.querySelectorAll('.comment-tag-check').forEach(c => c.addEventListener('change', () => {
    const n = el.querySelectorAll(`.comment-tag-check[data-post-id="${c.dataset.postId}"]:checked`).length;
    el.querySelector(`.comment-tag-btn[data-post-id="${c.dataset.postId}"]`).textContent = n ? `@ ${n}` : '@';
  }));
  el.querySelectorAll('.send-comment-btn').forEach(btn => btn.addEventListener('click', async () => {
    const postId = btn.dataset.postId;
    const input = el.querySelector(`.new-comment-input[data-post-id="${postId}"]`);
    const message = input.value.trim();
    if (!message) return;
    btn.disabled = true;
    const { data: comment, error: cErr } = await supabaseClient.from('feed_comments')
      .insert({ post_id: postId, author_id: opts.myUserId, message }).select('id').single();
    if (cErr) { alert(cErr.message); btn.disabled = false; return; }
    const tagged = [...el.querySelectorAll(`.comment-tag-check[data-post-id="${postId}"]:checked`)].map(c => c.value);
    if (tagged.length) {
      const { error: tagErr } = await supabaseClient.from('feed_mentions').insert(tagged.map(pid => ({ post_id: postId, comment_id: comment.id, profile_id: pid })));
      if (tagErr) alert(`Comment posted, but tagging failed: ${tagErr.message}`);
    }
    await reload();
  }));
  el.querySelectorAll('.feed-delete-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this post and its comments?')) return;
    const { error: dErr } = await supabaseClient.from('feed_posts').delete().eq('id', btn.dataset.postId);
    if (dErr) { alert(dErr.message); return; }
    await reload();
  }));

  // Opening the feed counts as seeing the tags on the posts that are on it.
  const seenIds = posts.filter(p => (opts.projectId ? true : !p.project_id)).map(p => p.id);
  if (seenIds.length) {
    supabaseClient.from('feed_mentions').update({ seen_at: new Date().toISOString() })
      .eq('profile_id', opts.myUserId).is('seen_at', null).in('post_id', seenIds)
      .then(() => {}, () => {});
  }
}
