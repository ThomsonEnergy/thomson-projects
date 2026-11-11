// The "client can see" ticks on a job's Photos and Documents tabs (backlog item 74). A photo or
// document is hidden from the client portal until it is ticked; a ticked one shows a small eye.
// Called by project.html right after each tab renders: shareWithClientPhotos(projectId, listEl,
// photos) and shareWithClientDocuments(projectId, listEl, docs). Writes project_photos.client_visible
// and project_documents.client_visible (one row per tap) and the activity log. Needs
// supabase-client.js (supabaseClient, escapeHtml, showToast, friendlyError, logActivity).

(function () {
  const EYE = '&#128065;';
  const KINDS = {
    // photos: every tile holds an <img> or <video> with data-photo-id
    photo: { table: 'project_photos', noun: 'photo', tiles: (listEl, rows) => {
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      return [...listEl.querySelectorAll('[data-photo-id]')].map((media) => [media.parentElement, byId[media.dataset.photoId]]);
    } },
    // documents: every .doc-tile holds a .doc-view-link with the file path
    document: { table: 'project_documents', noun: 'document', tiles: (listEl, rows) => {
      const byPath = Object.fromEntries(rows.map((r) => [r.file_path, r]));
      return [...listEl.querySelectorAll('.doc-tile')].map((tile) => [tile, byPath[tile.querySelector('.doc-view-link')?.dataset.path]]);
    } },
  };

  function barText(rows, noun) {
    const n = rows.filter((r) => r.client_visible).length;
    return `${EYE} ${n ? `${n} ${noun}${n === 1 ? '' : 's'} shared with the client.` : `Nothing shared with the client yet. Tick a ${noun} to show it in their portal.`}`;
  }

  function install(kindKey, projectId, listEl, rows) {
    const kind = KINDS[kindKey];
    rows = rows || [];
    listEl.insertAdjacentHTML('afterbegin', `<div class="swc-bar subtitle" style="margin:0 0 8px; font-size:12px;">${barText(rows, kind.noun)}</div>`);
    const bar = listEl.querySelector('.swc-bar');
    kind.tiles(listEl, rows).forEach(([tile, row]) => {
      if (!tile || !row || tile.querySelector('.swc-tick')) return;
      tile.insertAdjacentHTML('beforeend', `<label class="swc-tick" style="display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:11px; cursor:pointer; border-top:1px solid var(--border);">
        <input type="checkbox" ${row.client_visible ? 'checked' : ''} style="margin:0;" /> <span>${row.client_visible ? `${EYE} ` : ''}Client can see</span></label>`);
      const label = tile.querySelector('.swc-tick');
      const box = label.querySelector('input');
      box.addEventListener('change', async () => {
        const on = box.checked;
        const { error } = await supabaseClient.from(kind.table).update({ client_visible: on }).eq('id', row.id);
        if (error) { showToast(friendlyError(error), { error: true }); box.checked = !on; return; }
        row.client_visible = on;
        label.querySelector('span').innerHTML = `${on ? `${EYE} ` : ''}Client can see`;
        bar.innerHTML = barText(rows, kind.noun);
        logActivity('project', projectId, on ? 'client_share' : 'client_unshare', `${on ? 'Shared' : 'Hid'} a ${kind.noun} ${on ? 'with' : 'from'} the client`).catch(() => {});
      });
    });
  }

  window.shareWithClientPhotos = (projectId, listEl, photos) => install('photo', projectId, listEl, photos);
  window.shareWithClientDocuments = (projectId, listEl, docs) => install('document', projectId, listEl, docs);
})();
