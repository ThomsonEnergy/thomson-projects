// The "client can see" ticks on a job's Photos and Documents tabs (backlog item 74). A photo or
// document is hidden from the client portal until it is ticked; a ticked one shows a small eye.
// Called by project.html right after each tab renders: shareWithClientPhotos(projectId, listEl,
// photos) and shareWithClientDocuments(projectId, listEl, docs). Writes project_photos.client_visible
// and project_documents.client_visible (one row per tap) and the activity log. Needs
// supabase-client.js (supabaseClient, escapeHtml, showToast, friendlyError, logActivity).

(function () {
  const EYE = '&#128065;';

  function barHtml(id, count, noun) {
    return `<div id="${id}" class="subtitle" style="margin:0 0 8px; font-size:12px;">${EYE} ${count ? `${count} ${noun}${count === 1 ? '' : 's'} shared with the client.` : `Nothing shared with the client yet. Tick a ${noun} to show it in their portal.`}</div>`;
  }

  function tickHtml(id, on, kind) {
    return `<label class="swc-tick" style="display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:11px; cursor:pointer; border-top:1px solid var(--border); ${on ? 'color:var(--text);' : 'color:var(--muted);'}">
      <input type="checkbox" data-swc-kind="${kind}" data-swc-id="${escapeHtml(id)}" ${on ? 'checked' : ''} style="margin:0;" /> ${on ? `${EYE} Client can see` : 'Client can see'}
    </label>`;
  }

  async function toggle(kind, id, on, projectId, refresh) {
    const table = kind === 'photo' ? 'project_photos' : 'project_documents';
    const { error } = await supabaseClient.from(table).update({ client_visible: on }).eq('id', id);
    if (error) { showToast(friendlyError(error), { error: true }); refresh(); return; }
    logActivity('project', projectId, on ? 'client_share' : 'client_unshare', `${on ? 'Shared' : 'Hid'} a ${kind} ${on ? 'with' : 'from'} the client`).catch(() => {});
    refresh();
  }

  function wire(listEl, projectId, refresh) {
    listEl.querySelectorAll('input[data-swc-kind]').forEach((box) => {
      box.addEventListener('change', () => toggle(box.dataset.swcKind, box.dataset.swcId, box.checked, projectId, refresh));
    });
  }

  // photos: every tile holds an <img> or <video> with data-photo-id
  window.shareWithClientPhotos = function (projectId, listEl, photos) {
    const byId = Object.fromEntries((photos || []).map((p) => [p.id, p]));
    let shared = 0;
    listEl.querySelectorAll('[data-photo-id]').forEach((media) => {
      const p = byId[media.dataset.photoId];
      if (!p) return;
      const tile = media.parentElement;
      if (!tile || tile.querySelector('.swc-tick')) return;
      if (p.client_visible) shared += 1;
      tile.insertAdjacentHTML('beforeend', tickHtml(p.id, !!p.client_visible, 'photo'));
    });
    listEl.insertAdjacentHTML('afterbegin', barHtml('swc-photo-bar', shared, 'photo'));
    wire(listEl, projectId, () => { (photos || []).forEach((p) => { const box = listEl.querySelector(`input[data-swc-kind="photo"][data-swc-id="${p.id}"]`); if (box) p.client_visible = box.checked; }); listEl.querySelector('#swc-photo-bar')?.remove(); listEl.querySelectorAll('.swc-tick').forEach((t) => t.remove()); window.shareWithClientPhotos(projectId, listEl, photos); });
  };

  // documents: every .doc-tile holds a .doc-view-link with the file path
  window.shareWithClientDocuments = function (projectId, listEl, docs) {
    const byPath = Object.fromEntries((docs || []).map((d) => [d.file_path, d]));
    let shared = 0;
    listEl.querySelectorAll('.doc-tile').forEach((tile) => {
      const path = tile.querySelector('.doc-view-link')?.dataset.path;
      const d = byPath[path];
      if (!d || tile.querySelector('.swc-tick')) return;
      if (d.client_visible) shared += 1;
      tile.insertAdjacentHTML('beforeend', tickHtml(d.id, !!d.client_visible, 'document'));
    });
    listEl.insertAdjacentHTML('afterbegin', barHtml('swc-doc-bar', shared, 'document'));
    wire(listEl, projectId, () => { (docs || []).forEach((d) => { const box = listEl.querySelector(`input[data-swc-kind="document"][data-swc-id="${d.id}"]`); if (box) d.client_visible = box.checked; }); listEl.querySelector('#swc-doc-bar')?.remove(); listEl.querySelectorAll('.swc-tick').forEach((t) => t.remove()); window.shareWithClientDocuments(projectId, listEl, docs); });
  };
})();
