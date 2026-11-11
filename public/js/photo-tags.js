// Picture tags in the browser (backlog item 73b): the tags the picture tagger put on a job
// picture (project_photos.tags: brands, what it shows, models, the kind of picture), shown under
// each picture on the Site Photos tab, searched by the box above them, and changed by hand when
// the tagger has it wrong. Also finds recent finished installs with the same gear for a quote
// (quote-pictures.js).
//
// Who loads it: project.html when the Site Photos tab opens, and quote-pictures.js. Writes
// project_photos.tags only (the tag editor). The tagging itself is server side
// (netlify/functions/_shared/photo-tagger.js); requestPhotoTags() in supabase-client.js starts it
// after an upload.

// The search typed on the Site Photos tab (kept while the tab is redrawn).
let sitePhotoQuery = '';
let photoQueryFromUrlUsed = false; // ?photo_q= fills the box once, not on every redraw

// a text button that reads on every theme (a bare button takes the theme's button colours)
const PHOTO_LINK_STYLE = 'background:none; border:none; padding:0; min-height:0; color:var(--link); cursor:pointer;';

const photoTagWords = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9. -]/g, ' ').split(/\s+/).filter(Boolean);

// True when every word typed is found in the picture's tags, captions or who took it.
function photoMatchesSearch(photo, q) {
  const words = photoTagWords(q);
  if (!words.length) return true;
  const hay = [...(photo.tags || []), photo.caption || '', photo.ai_caption || '', (photo.profiles || {}).full_name || ''].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}
const sitePhotoSearchFilter = (photos) => photos.filter(p => photoMatchesSearch(p, sitePhotoQuery));

// The line under a picture: its first few tags and a link to change them.
function photoTagsLineHtml(photo) {
  const tags = photo.tags || [];
  const shown = tags.slice(0, 4);
  return `<div class="photo-tags" style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
    ${shown.map(t => `<span style="font-size:10.5px; padding:1px 6px; border:1px solid var(--border); border-radius:10px; color:var(--text);">${escapeHtml(t)}</span>`).join('')}
    ${tags.length > shown.length ? `<span style="font-size:10.5px;">+${tags.length - shown.length}</span>` : ''}
    <button type="button" class="link-quiet photo-tags-edit" data-photo-id="${escapeHtml(photo.id)}" style="${PHOTO_LINK_STYLE} font-size:10.5px;">${tags.length ? 'Edit' : 'Add tags'}</button>
  </div>`;
}

// The search box above the Site Photos list. onChange redraws the list (which filters through
// sitePhotoSearchFilter). initial: a search carried in from the top search bar.
function mountSitePhotoSearch({ el, initial, onChange }) {
  if (!el || el.dataset.mounted) return;
  el.dataset.mounted = '1';
  if (initial && !photoQueryFromUrlUsed) { sitePhotoQuery = initial; photoQueryFromUrlUsed = true; }
  el.innerHTML = `<input type="search" id="site-photo-q" placeholder="Search these pictures: Sigenergy, switchboard, before..." autocomplete="off" value="${escapeHtml(sitePhotoQuery)}" style="margin:12px 0 0;" />`;
  let timer = null;
  el.querySelector('#site-photo-q').addEventListener('input', (e) => {
    sitePhotoQuery = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(onChange, 200);
  });
}

// Sets up the Site Photos tab: the search box (filled from ?photo_q= when the top search bar sent
// the person here) and the Edit link under each picture. redraw reloads the list. Safe to call
// each time the tab opens.
function wireSitePhotoTags(redraw) {
  mountSitePhotoSearch({ el: document.getElementById('site-photo-search'), initial: new URLSearchParams(location.search).get('photo_q') || '', onChange: redraw });
  const listEl = document.getElementById('site-photos-list');
  if (!listEl || listEl.dataset.tagsWired) return;
  listEl.dataset.tagsWired = '1';
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.photo-tags-edit');
    if (!btn) return;
    const { data, error } = await supabaseClient.from('project_photos').select('id, tags, ok_for_proposals').eq('id', btn.dataset.photoId).single();
    if (error) { showToast(friendlyError(error)); return; }
    openPhotoTagEditor({ photo: data, onSaved: redraw });
  });
}

// Add or take off a picture's tags by hand, and say whether it may be shown to other customers
// (the tagger only suggests that: a person has the last word). photo: { id, tags,
// ok_for_proposals }. onSaved(tags) after the save.
function openPhotoTagEditor({ photo, onSaved }) {
  let tags = (photo.tags || []).slice();
  const overlay = openModal(`
      <h2 style="margin-bottom:4px;">Tags on this picture</h2>
      <p class="subtitle" style="margin:0 0 10px;">Pictures are found by their tags. Take off one that is wrong, or add your own (a brand, what it shows, a model).</p>
      <div id="pt-chips" style="display:flex; gap:6px; flex-wrap:wrap; min-height:28px;"></div>
      <div style="display:flex; gap:8px; margin-top:10px;"><input type="text" id="pt-new" maxlength="40" placeholder="Add a tag" style="margin:0;" /><button type="button" class="secondary" id="pt-add">Add</button></div>
      <label style="display:flex; align-items:center; gap:8px; margin:12px 0 0; font-weight:400;"><input type="checkbox" id="pt-ok" style="width:auto; margin:0;" ${photo.ok_for_proposals ? 'checked' : ''} /> Fine to show other customers on a proposal (a finished job, nobody and nothing identifying in it)</label>
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="pt-save">Save</button><button type="button" class="secondary" id="pt-cancel">Cancel</button></div>
      <div id="pt-msg"></div>`, { maxWidth: 440, zIndex: 120 });
  const chips = overlay.querySelector('#pt-chips');
  const draw = () => {
    chips.innerHTML = tags.length ? tags.map((t, i) => `<span style="font-size:12.5px; padding:3px 8px; border:1px solid var(--border); border-radius:12px;">${escapeHtml(t)} <button type="button" class="link-quiet pt-x" data-i="${i}" title="Take off" style="${PHOTO_LINK_STYLE} padding-left:4px;">&times;</button></span>`).join('') : '<span class="subtitle" style="font-size:12.5px;">No tags yet.</span>';
    chips.querySelectorAll('.pt-x').forEach(b => b.addEventListener('click', () => { tags.splice(Number(b.dataset.i), 1); draw(); }));
  };
  const add = () => {
    const input = overlay.querySelector('#pt-new');
    const t = input.value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (t && !tags.includes(t)) tags.push(t);
    input.value = '';
    draw();
  };
  overlay.querySelector('#pt-add').addEventListener('click', add);
  overlay.querySelector('#pt-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  overlay.querySelector('#pt-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#pt-save').addEventListener('click', async () => {
    add(); // a tag typed but not yet added still counts
    const btn = overlay.querySelector('#pt-save');
    btn.disabled = true;
    const { error } = await supabaseClient.from('project_photos').update({ tags, ok_for_proposals: overlay.querySelector('#pt-ok').checked }).eq('id', photo.id);
    if (error) {
      overlay.querySelector('#pt-msg').innerHTML = `<div class="error-box" style="margin-top:8px;">${escapeHtml(friendlyError(error))}</div>`;
      btn.disabled = false;
      return;
    }
    overlay.remove();
    showToast('Tags saved.');
    if (onSaved) onSaved(tags);
  });
  draw();
}

// The brands on a quote, as tags to look for: every known brand named in the Pylon models or the
// stage lines. Only names on this list are ever searched for (a model's first word can be "2x").
const PHOTO_BRANDS = ['sigenergy', 'fronius', 'sungrow', 'victron', 'winaico', 'tesla', 'enphase', 'solaredge', 'goodwe', 'byd', 'alpha ess', 'trina', 'jinko', 'longi', 'rec', 'sma', 'growatt', 'redback', 'selectronic', 'pylontech', 'canadian solar', 'ja solar', 'q cells', 'zappi', 'clipsal', 'hager', 'nhp'];
function quoteBrands(project) {
  const pd = project.pylon_data || {};
  const text = [
    ...[...(pd.module_types || []), ...(pd.inverter_types || []), ...(pd.storage_types || [])].map(m => (m && m.description) || ''),
    ...(project.cost_centres || []).flatMap(c => (c.cost_centre_line_items || []).map(li => `${li.description || ''} ${li.prebuild_client_description || ''}`)),
  ].join(' ').toLowerCase();
  return PHOTO_BRANDS.filter(b => new RegExp(`\\b${b}\\b`).test(text));
}

// Recent finished installs to offer on a quote: pictures on other jobs (a job number, so the work
// was won and done by us: never a customer's own picture on a quote or a lead), taken after that
// job was approved, carrying one of these brand tags and marked fine for other customers. Newest
// first.
async function recentInstallPhotos({ brands, excludeProjectId, limit = 12 }) {
  if (!brands || !brands.length) return [];
  let q = supabaseClient.from('project_photos').select('id, url, tags, ai_caption, project_id, created_at, projects!inner(job_number, approved_at)')
    .eq('ok_for_proposals', true).overlaps('tags', brands).not('projects.job_number', 'is', null).order('created_at', { ascending: false }).limit(limit * 2);
  if (excludeProjectId) q = q.neq('project_id', excludeProjectId);
  const { data, error } = await q;
  if (error) return []; // before the tags exist (migration 20261130100000) there is nothing to offer
  return (data || []).filter(p => !p.projects.approved_at || p.created_at >= p.projects.approved_at).slice(0, limit);
}
