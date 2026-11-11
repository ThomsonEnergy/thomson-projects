// Step 4 of a quote: Pictures of your system (backlog item 73a). The pictures a proposal shows
// the client, each with a caption printed under it so the client always knows whose place it is:
// "Your site" (their wall from the site visit), "Similar system" (another job with the same gear)
// or "Indicative picture" (a product shot, a render), or the staff's own words. A Solar or Battery
// proposal prints them on its Your system page; the other types under "What it will look like"
// on their Photos page (quote.html).
//
// Who calls it: project.html, when the Quote tab is built, as mountQuotePictures({ el, project,
// onSettled }). Writes projects.reference_photos ([{ url, caption }]; an older quote's pictures
// have no caption and stay as they are) every time something changes: there is no Save to press.
// onSettled runs once, a few seconds after the last change has saved (the page remakes the PDF
// then). Reads project_photos and the quote's site inspection answers for "From this job's
// pictures", and other jobs' tagged pictures for "Recent installs with this gear" (js/photo-tags.js,
// item 73b); a picked picture is copied, so deleting it from Site Photos later never empties the
// proposal. Uploads go through uploadPhotos(), which compresses them.

const QUOTE_PICTURE_CAPTIONS = ['Your site', 'Similar system', 'Indicative picture'];

function mountQuotePictures({ el, project, onSettled }) {
  if (!el) return;
  // older rows are a bare link or { url }: both read as a picture with no caption
  let list = (project.reference_photos || []).map(p => (typeof p === 'string' ? { url: p } : p)).filter(p => p && p.url)
    .map(p => ({ url: p.url, caption: String(p.caption || '') }));
  let queue = Promise.resolve();
  let typing = null, settle = null, inFlight = 0;
  const rowsNow = () => list.map(p => (p.caption.trim() ? { url: p.url, caption: p.caption.trim() } : { url: p.url }));

  el.innerHTML = `
    <label style="margin-top:14px; font-weight:600;">Pictures of your system</label>
    <p class="subtitle" style="margin:2px 0 8px;">Printed on the proposal with the caption under each picture, so the client knows whether it is their place. Saved as you go.</p>
    <div class="qp-list"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <label class="qp-add" style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">Add pictures of their site<input type="file" class="qp-file" data-caption="Your site" accept="image/*" multiple style="display:none;" /></label>
      <label class="qp-add" style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">Add other pictures<input type="file" class="qp-file" data-caption="Indicative picture" accept="image/*" multiple style="display:none;" /></label>
      <button type="button" class="secondary qp-pick" style="font-size:13px; padding:8px 12px;">From this job's pictures</button>
    </div>
    <div class="qp-state" style="font-size:12px; min-height:18px; margin-top:6px;"></div>
    <div class="qp-recent"></div>`;
  const listEl = el.querySelector('.qp-list');
  const stateEl = el.querySelector('.qp-state');
  const say = (text, bad) => { stateEl.innerHTML = `<span ${bad ? 'style="color:var(--red);"' : 'class="subtitle"'}>${escapeHtml(text)}</span>`; };

  // Writes the whole list, one save after another so the last change always lands last. The page's
  // copy of the quote is brought up to date straight away, so a redraw of the tab shows it too.
  function save() {
    clearTimeout(typing); typing = null;
    clearTimeout(settle);
    const rows = rowsNow();
    project.reference_photos = rows;
    say('Saving...');
    inFlight++;
    queue = queue.then(async () => {
      const { error } = await supabaseClient.from('projects').update({ reference_photos: rows }).eq('id', project.id);
      if (error) throw error;
      say('Saved.');
      // once things go quiet (the PDF is remade once, not on every tap)
      if (onSettled) settle = setTimeout(() => onSettled(rows), 4000);
    }).catch((err) => {
      stateEl.innerHTML = `<span style="color:var(--red);">Not saved: ${escapeHtml(friendlyError(err))}</span> <button type="button" class="link-quiet qp-retry" style="background:none; border:none; padding:0; cursor:pointer;">Try again</button>`;
      stateEl.querySelector('.qp-retry').addEventListener('click', save);
    }).finally(() => { inFlight--; });
    return queue;
  }
  // leaving with a caption still being typed or a save on its way asks first
  window.addEventListener('beforeunload', (e) => { if (typing || inFlight) { e.preventDefault(); e.returnValue = ''; } });

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
      const input = row.querySelector('.qp-caption');
      row.querySelector('.qp-thumb').addEventListener('click', () => openPhotoLightbox(list.map(p => p.url), i));
      // typing a caption: the row is updated where it stands (a redraw would take the cursor away),
      // saved after a pause and at once when the box is left
      input.addEventListener('input', () => {
        list[i].caption = input.value;
        project.reference_photos = rowsNow();
        row.querySelector('.qp-none').style.display = input.value.trim() ? 'none' : '';
        row.querySelectorAll('.qp-chip').forEach(b => b.classList.toggle('secondary', b.dataset.caption !== input.value));
        clearTimeout(typing);
        typing = setTimeout(save, 900);
      });
      input.addEventListener('change', () => { if (typing) save(); });
      row.querySelectorAll('.qp-chip').forEach(b => b.addEventListener('click', () => { list[i].caption = b.dataset.caption; render(); save(); }));
      row.querySelector('.qp-remove').addEventListener('click', () => { list.splice(i, 1); render(); save(); });
    });
  }

  el.querySelectorAll('.qp-file').forEach(input => input.addEventListener('change', async () => {
    if (!input.files.length) return;
    say(`Uploading ${input.files.length} picture${input.files.length === 1 ? '' : 's'}...`);
    try {
      const urls = await uploadPhotos(input.files, 'reference');
      urls.forEach(url => list.push({ url, caption: input.dataset.caption }));
      render();
      save();
    } catch (err) {
      say(friendlyError(err), true);
    }
    input.value = '';
  }));

  // Puts copies of pictures that live elsewhere (Site Photos, another job) on this quote: its own
  // copy, so the proposal keeps the picture whatever happens to the original.
  async function copyIn(photos, caption) {
    const files = await Promise.all(photos.map(async (p, n) => {
      const res = await fetch(p.url);
      if (!res.ok) throw new Error('A picture could not be read. Try again.');
      const blob = await res.blob();
      return new File([blob], `job-picture-${n + 1}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`, { type: blob.type || 'image/jpeg' });
    }));
    const urls = await uploadPhotos(files, 'reference');
    urls.forEach(url => list.push({ url, caption }));
    render();
    save();
  }

  // Recent installs with this gear: finished jobs' pictures tagged with a brand on this quote and
  // marked fine for proposals, offered without a search. A tap adds one, captioned "Similar system".
  const recentEl = el.querySelector('.qp-recent');
  loadJsOnce('/js/photo-tags.js?v=1', () => typeof recentInstallPhotos === 'function').then(async () => {
    const brands = quoteBrands(project);
    const photos = await recentInstallPhotos({ brands, excludeProjectId: project.id });
    if (!photos.length) return;
    recentEl.innerHTML = `
      <label style="margin-top:14px; font-weight:600;">Recent installs with this gear</label>
      <p class="subtitle" style="margin:2px 0 8px;">Finished jobs with ${escapeHtml(brands.join(', '))} on them. Tap one to add it, captioned "Similar system".</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px;">
        ${photos.map((p, i) => `<button type="button" class="qp-recent-add" data-i="${i}" title="${escapeHtml(p.ai_caption || '')}" style="padding:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:none; cursor:pointer;"><img src="${escapeHtml(supaImageVariant(p.url, 200, 60))}" alt="${escapeHtml(p.ai_caption || '')}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:cover; display:block;" /></button>`).join('')}
      </div>`;
    recentEl.querySelectorAll('.qp-recent-add').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      say('Adding the picture...');
      try { await copyIn([photos[Number(b.dataset.i)]], 'Similar system'); b.remove(); }
      catch (err) { say(friendlyError(err), true); b.disabled = false; }
    }));
  }).catch(() => {});

  // This job's own pictures (Site Photos and the site visit's checklist pictures): tick the ones
  // to show the client. Each ticked picture is copied into the proposal's own folder.
  const pickBtn = el.querySelector('.qp-pick');
  pickBtn.addEventListener('click', async () => {
    pickBtn.disabled = true;
    try {
      const LIMIT = 300;
      const insp = typeof findLinkedSiteInspection === 'function' ? await findLinkedSiteInspection(project).catch(() => null) : null;
      const [{ data, error }, { data: answers }] = await Promise.all([
        supabaseClient.from('project_photos').select('url, caption, created_at').eq('project_id', project.id).order('created_at', { ascending: false }).limit(LIMIT),
        insp ? supabaseClient.from('site_inspection_answers').select('photo_path, photo_paths').eq('inspection_id', insp.id) : Promise.resolve({ data: [] }),
      ]);
      if (error) throw error;
      const visit = (answers || []).flatMap(a => (Array.isArray(a.photo_paths) && a.photo_paths.length ? a.photo_paths : (a.photo_path ? [a.photo_path] : [])));
      const seen = new Set();
      const photos = [...visit.map(url => ({ url, caption: 'Site visit' })), ...(data || [])]
        .filter(p => p.url && !isVideoUrl(p.url) && !/\.pdf(\?|$)/i.test(p.url) && !seen.has(p.url) && seen.add(p.url));
      const overlay = openModal(`
        <h2 style="margin-bottom:4px;">This job's pictures</h2>
        <p class="subtitle" style="margin:0 0 10px;">${photos.length ? `Tap the ones to show on the proposal. Each gets the caption "Your site".${(data || []).length >= LIMIT ? ` Showing the newest ${LIMIT}.` : ''}` : 'No pictures on this job yet. Add them on the Site Photos tab, or use the Add buttons.'}</p>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px; max-height:55vh; overflow:auto;">
          ${photos.map((p, i) => `<label style="margin:0; position:relative; cursor:pointer;"><input type="checkbox" class="qp-tick" data-i="${i}" style="position:absolute; top:6px; left:6px; width:18px; height:18px; margin:0;" /><img src="${escapeHtml(supaImageVariant(p.url, 200, 60))}" alt="${escapeHtml(p.caption || '')}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; display:block;" /></label>`).join('')}
        </div>
        <div id="qp-pick-msg" style="font-size:12px;"></div>
        <div style="margin-top:12px; display:flex; gap:8px;">${photos.length ? '<button type="button" id="qp-add-picked">Add to the proposal</button>' : ''}<button type="button" class="secondary" id="qp-pick-close">Close</button></div>`, { maxWidth: 560, zIndex: 110 });
      overlay.querySelector('#qp-pick-close').addEventListener('click', () => overlay.remove());
      const add = overlay.querySelector('#qp-add-picked');
      if (add) add.addEventListener('click', async () => {
        const picked = [...overlay.querySelectorAll('.qp-tick:checked')].map(c => photos[Number(c.dataset.i)]);
        if (!picked.length) { overlay.remove(); return; }
        add.disabled = true; add.textContent = `Copying ${picked.length} picture${picked.length === 1 ? '' : 's'}...`;
        try {
          await copyIn(picked, 'Your site');
          overlay.remove();
        } catch (err) {
          overlay.querySelector('#qp-pick-msg').innerHTML = `<div class="error-box" style="margin-top:8px;">${escapeHtml(friendlyError(err))}</div>`;
          add.disabled = false; add.textContent = 'Add to the proposal';
        }
      });
    } catch (err) {
      say(friendlyError(err), true);
    } finally { pickBtn.disabled = false; }
  });

  render();
}
