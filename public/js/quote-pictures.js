// Step 4 of a quote: Pictures of your system (backlog item 73a). The pictures a proposal shows
// the client, each with a caption printed under it so the client always knows whose place it is:
// "Your site" (their wall from the site visit), "Similar system" (another job with the same gear)
// or "Indicative picture" (a product shot, a render), or the staff's own words. A Solar or Battery
// proposal prints them on its Your system page; the other types under "What it will look like"
// on their Photos page (quote.html).
//
// Who calls it: project.html, when the Quote tab is built, as mountQuotePictures({ el, project,
// onSaved }). Writes projects.reference_photos ([{ url, caption }]; an older quote's pictures have
// no caption and stay as they are) every time something changes: there is no Save to press.
// Reads project_photos for "From this job's pictures". Uploads go through uploadPhotos(), which
// compresses them.

const QUOTE_PICTURE_CAPTIONS = ['Your site', 'Similar system', 'Indicative picture'];

function mountQuotePictures({ el, project, onSaved }) {
  if (!el) return;
  // older rows are a bare link or { url }: both read as a picture with no caption
  let list = (project.reference_photos || []).map(p => (typeof p === 'string' ? { url: p } : p)).filter(p => p && p.url)
    .map(p => ({ url: p.url, caption: String(p.caption || '') }));
  let queue = Promise.resolve();
  let typing = null;

  el.innerHTML = `
    <label style="margin-top:14px; font-weight:600;">Pictures of your system</label>
    <p class="subtitle" style="margin:2px 0 8px;">Printed on the proposal with the caption under each picture, so the client knows whether it is their place. Saved as you go.</p>
    <div class="qp-list"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <label class="qp-add" style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">Add pictures of their site<input type="file" class="qp-file" data-caption="Your site" accept="image/*" multiple style="display:none;" /></label>
      <label class="qp-add" style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">Add other pictures<input type="file" class="qp-file" data-caption="Indicative picture" accept="image/*" multiple style="display:none;" /></label>
      <button type="button" class="secondary qp-pick" style="font-size:13px; padding:8px 12px;">From this job's pictures</button>
    </div>
    <div class="qp-state" style="font-size:12px; min-height:18px; margin-top:6px;"></div>`;
  const listEl = el.querySelector('.qp-list');
  const stateEl = el.querySelector('.qp-state');

  // Writes the whole list, one save after another so the last change always lands last.
  function save() {
    clearTimeout(typing);
    const rows = list.map(p => (p.caption.trim() ? { url: p.url, caption: p.caption.trim() } : { url: p.url }));
    stateEl.innerHTML = '<span class="subtitle">Saving...</span>';
    queue = queue.then(async () => {
      const { error } = await supabaseClient.from('projects').update({ reference_photos: rows }).eq('id', project.id);
      if (error) throw error;
      project.reference_photos = rows;
      stateEl.innerHTML = '<span class="subtitle">Saved.</span>';
      if (onSaved) onSaved(rows);
    }).catch((err) => {
      stateEl.innerHTML = `<span style="color:var(--red);">Not saved: ${escapeHtml(friendlyError(err))}</span> <button type="button" class="link-quiet qp-retry" style="background:none; border:none; padding:0; cursor:pointer;">Try again</button>`;
      stateEl.querySelector('.qp-retry').addEventListener('click', save);
    });
    return queue;
  }

  function render() {
    listEl.innerHTML = list.length ? list.map((p, i) => `
      <div class="qp-row" data-i="${i}" style="display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-bottom:1px solid var(--border);">
        <img class="qp-thumb" src="${escapeHtml(supaImageVariant(p.url, 200, 60))}" alt="" loading="lazy" style="width:84px; height:84px; object-fit:cover; border-radius:8px; cursor:pointer; flex:none;" />
        <div style="flex:1; min-width:0;">
          <input type="text" class="qp-caption" maxlength="80" placeholder="Caption under the picture" value="${escapeHtml(p.caption)}" style="margin:0 0 6px;" />
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            ${QUOTE_PICTURE_CAPTIONS.map(c => `<button type="button" class="${p.caption === c ? '' : 'secondary '}qp-chip" data-caption="${escapeHtml(c)}" style="font-size:12px; padding:4px 10px;">${escapeHtml(c)}</button>`).join('')}
            <button type="button" class="link-quiet qp-remove" style="background:none; border:none; padding:0; margin-left:4px; font-size:12px; cursor:pointer;">Remove</button>
          </div>
          <p class="subtitle qp-none" style="margin:4px 0 0; font-size:11.5px;${p.caption.trim() ? ' display:none;' : ''}">No caption: the client may take this for their own place.</p>
        </div>
      </div>`).join('') : '<p class="subtitle" style="margin:0; font-size:12.5px;">No pictures on this quote yet.</p>';
    listEl.querySelectorAll('.qp-row').forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector('.qp-thumb').addEventListener('click', () => openPhotoLightbox(list.map(p => p.url), i));
      // typing a caption: the row is updated where it stands (a redraw would take the cursor away)
      row.querySelector('.qp-caption').addEventListener('input', (e) => {
        list[i].caption = e.target.value;
        row.querySelector('.qp-none').style.display = e.target.value.trim() ? 'none' : '';
        row.querySelectorAll('.qp-chip').forEach(b => b.classList.toggle('secondary', b.dataset.caption !== e.target.value));
        clearTimeout(typing);
        typing = setTimeout(save, 900);
      });
      row.querySelectorAll('.qp-chip').forEach(b => b.addEventListener('click', () => { list[i].caption = b.dataset.caption; render(); save(); }));
      row.querySelector('.qp-remove').addEventListener('click', () => { list.splice(i, 1); render(); save(); });
    });
  }

  el.querySelectorAll('.qp-file').forEach(input => input.addEventListener('change', async () => {
    if (!input.files.length) return;
    stateEl.innerHTML = `<span class="subtitle">Uploading ${input.files.length} picture${input.files.length === 1 ? '' : 's'}...</span>`;
    try {
      const urls = await uploadPhotos(input.files, 'reference');
      urls.forEach(url => list.push({ url, caption: input.dataset.caption }));
      render();
      save();
    } catch (err) {
      stateEl.innerHTML = `<span style="color:var(--red);">${escapeHtml(friendlyError(err))}</span>`;
    }
    input.value = '';
  }));

  // The job's own Site Photos (taken on the site visit, say): tick the ones to show the client.
  el.querySelector('.qp-pick').addEventListener('click', async () => {
    const { data, error } = await supabaseClient.from('project_photos').select('url, caption, created_at').eq('project_id', project.id).order('created_at', { ascending: false }).limit(300);
    if (error) { stateEl.innerHTML = `<span style="color:var(--red);">${escapeHtml(friendlyError(error))}</span>`; return; }
    const have = new Set(list.map(p => p.url));
    const photos = (data || []).filter(p => p.url && !isVideoUrl(p.url) && !have.has(p.url));
    const overlay = openModal(`
      <h2 style="margin-bottom:4px;">This job's pictures</h2>
      <p class="subtitle" style="margin:0 0 10px;">${photos.length ? 'Tap the ones to show on the proposal. They go on captioned "Your site".' : 'No pictures on this job yet (or they are all on the proposal already). Add them on the Site Photos tab, or use the Add buttons.'}</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px; max-height:55vh; overflow:auto;">
        ${photos.map((p, i) => `<label style="margin:0; position:relative; cursor:pointer;"><input type="checkbox" class="qp-tick" data-i="${i}" style="position:absolute; top:6px; left:6px; width:18px; height:18px; margin:0;" /><img src="${escapeHtml(supaImageVariant(p.url, 200, 60))}" alt="${escapeHtml(p.caption || '')}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; display:block;" /></label>`).join('')}
      </div>
      <div style="margin-top:12px; display:flex; gap:8px;">${photos.length ? '<button type="button" id="qp-add-picked">Add to the proposal</button>' : ''}<button type="button" class="secondary" id="qp-pick-close">Close</button></div>`, { maxWidth: 560, zIndex: 110 });
    overlay.querySelector('#qp-pick-close').addEventListener('click', () => overlay.remove());
    const add = overlay.querySelector('#qp-add-picked');
    if (add) add.addEventListener('click', () => {
      const picked = [...overlay.querySelectorAll('.qp-tick:checked')].map(c => photos[Number(c.dataset.i)]);
      overlay.remove();
      if (!picked.length) return;
      picked.forEach(p => list.push({ url: p.url, caption: 'Your site' }));
      render();
      save();
    });
  });

  render();
}
