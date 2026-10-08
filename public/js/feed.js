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

function feedWhen(iso) {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// Builds the "write a post" box into `el`. opts: { myUserId, projectId (a job
// feed), onPosted }. A job post has a "also show on the Home page" tick; any
// post can tag people.
async function mountFeedComposer(el, opts) {
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
  let q = supabaseClient.from('feed_posts')
    .select('*, profiles(full_name), projects(id, name, job_number, quote_number)')
    .order('created_at', { ascending: false }).limit(opts.limit || 30);
  q = opts.projectId ? q.eq('project_id', opts.projectId) : q.or('project_id.is.null,show_on_home.eq.true');
  const { data: posts, error } = await q;
  if (error) { el.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
  if (!posts.length) { el.innerHTML = `<p class="subtitle">${opts.projectId ? 'No notes on this job yet - add the first one above.' : 'No posts yet - be the first.'}</p>`; return; }

  const staff = (await feedStaff()).filter(p => p.id !== opts.myUserId);
  const postIds = posts.map(p => p.id);
  const [{ data: likes }, { data: comments }, { data: mentions }] = await Promise.all([
    supabaseClient.from('feed_likes').select('post_id, author_id').in('post_id', postIds),
    supabaseClient.from('feed_comments').select('*, profiles(full_name)').in('post_id', postIds).order('created_at'),
    supabaseClient.from('feed_mentions').select('post_id, comment_id, profile_id, profiles(full_name)').in('post_id', postIds),
  ]);

  const projectRefOf = (p) => (typeof projectRef === 'function' ? projectRef(p) : (p.name || 'Job'));
  el.innerHTML = posts.map(post => {
    const postLikes = (likes || []).filter(l => l.post_id === post.id);
    const iLiked = postLikes.some(l => l.author_id === opts.myUserId);
    const postComments = (comments || []).filter(c => c.post_id === post.id);
    const tagged = (mentions || []).filter(m => m.post_id === post.id && !m.comment_id);
    const mine = post.author_id === opts.myUserId;
    return `
      <div class="feed-post" data-post-id="${post.id}">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start; flex-wrap:wrap;">
          <div>
            <span class="feed-author">${escapeHtml(post.profiles ? post.profiles.full_name : 'Someone')}</span>
            ${post.projects && !opts.projectId ? `<a href="/project.html?id=${post.projects.id}&tab=feed" class="badge sent" style="margin-left:8px; text-decoration:none;">${escapeHtml(projectRefOf(post.projects))}</a>` : ''}
            <div class="feed-meta">${feedWhen(post.created_at)}${post.projects && opts.projectId && post.show_on_home ? ' &middot; also on Home' : ''}</div>
          </div>
          ${(mine || opts.isAdmin) ? `<button type="button" class="feed-like-btn feed-delete-btn" data-post-id="${post.id}" title="Delete this post">Delete</button>` : ''}
        </div>
        <p style="margin:8px 0 0; white-space:pre-wrap;">${escapeHtml(post.message)}</p>
        ${tagged.length ? `<p class="feed-meta" style="margin:6px 0 0;">Tagged: ${tagged.map(t => escapeHtml((t.profiles && t.profiles.full_name) || 'Someone')).join(', ')}</p>` : ''}
        <div class="feed-actions">
          <button class="feed-like-btn ${iLiked ? 'liked' : ''}" data-post-id="${post.id}" data-liked="${iLiked}">
            &#128077; ${postLikes.length || ''} ${iLiked ? 'Liked' : 'Like'}
          </button>
          <button class="feed-like-btn toggle-comments-btn" data-post-id="${post.id}">&#128172; Comment${postComments.length ? ' (' + postComments.length + ')' : ''}</button>
        </div>
        <div class="feed-comments" data-post-id="${post.id}" style="display:${postComments.length && opts.projectId ? 'block' : 'none'}; margin-top:10px; padding-left:12px; border-left:2px solid var(--border);">
          ${postComments.map(c => `
            <div class="feed-comment">
              <span class="feed-author">${escapeHtml(c.profiles ? c.profiles.full_name : 'Someone')}</span>
              <span class="feed-meta">${feedWhen(c.created_at)}</span>
              <div style="white-space:pre-wrap;">${escapeHtml(c.message)}</div>
              ${(mentions || []).filter(m => m.comment_id === c.id).length ? `<div class="feed-meta">Tagged: ${(mentions || []).filter(m => m.comment_id === c.id).map(t => escapeHtml((t.profiles && t.profiles.full_name) || 'Someone')).join(', ')}</div>` : ''}
            </div>`).join('')}
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input class="new-comment-input" data-post-id="${post.id}" placeholder="Write a comment..." style="flex:1;" />
            <button type="button" class="secondary comment-tag-btn" data-post-id="${post.id}" title="Tag people in this comment" style="padding:8px 12px;">@</button>
            <button class="secondary send-comment-btn" data-post-id="${post.id}" style="padding:8px 14px;">Send</button>
          </div>
          <div class="comment-tag-panel" data-post-id="${post.id}" style="display:none; margin-top:6px; padding:10px; border:1px solid var(--border); border-radius:8px; max-height:160px; overflow-y:auto;">
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:4px 12px;">
              ${staff.map(p => `<label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="checkbox" class="comment-tag-check" data-post-id="${post.id}" value="${p.id}" style="width:auto;" /> ${escapeHtml(p.full_name || 'Unnamed')}</label>`).join('')}
            </div>
          </div>
        </div>
      </div>`;
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
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
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
