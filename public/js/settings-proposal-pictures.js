// Settings > Company Details > Proposal pictures (backlog item 73a): the title page picture for
// each proposal type and the one picture beside "About Thomson Energy" on every proposal. A box
// with no picture of its own shows the built-in one, which is what the proposal then uses.
//
// Who calls it: settings.html, loadSettings() (loaded the first time Company Details is filled),
// as loadProposalPicturesCard(settingsRow). Writes company_settings.proposal_cover_photos and
// about_photo_url, each the moment a picture is chosen or taken off: there is no Save to press.
// The client's proposal reads both through get_public_company_settings() (quote.html).

// The proposal types that print a title page, keyed as projects.proposal_template, and the
// built-in picture each falls back to (the same two quote.html uses).
const PROPOSAL_PICTURE_TYPES = [
  { key: 'solar', label: 'Solar' },
  { key: 'battery', label: 'Battery', builtIn: '/img/showcase/battery.jpg' },
  { key: 'new_build', label: 'New Build' },
  { key: 'renovation', label: 'Renovation' },
  { key: 'service_work', label: 'Service Work' },
  { key: 'quick_estimate', label: 'Quick Estimate' },
];
const PROPOSAL_PICTURE_BUILT_IN = '/img/showcase/shed-solar.jpg';
const ABOUT_PICTURE_BUILT_IN = '/img/showcase/campus-solar.jpg';

function loadProposalPicturesCard(settings) {
  const card = document.getElementById('proposal-pictures-card');
  if (!card) return;
  let covers = (settings && settings.proposal_cover_photos && typeof settings.proposal_cover_photos === 'object') ? { ...settings.proposal_cover_photos } : {};
  let about = (settings && settings.about_photo_url) || '';

  const tile = (id, label, url, builtIn, note) => `
    <div class="pp-tile" data-id="${escapeHtml(id)}" style="border:1px solid var(--border); border-radius:8px; padding:10px;">
      <div style="font-weight:600; font-size:13px; margin-bottom:6px;">${escapeHtml(label)}</div>
      <img src="${escapeHtml(url ? supaImageVariant(url, 500, 70) : builtIn)}" alt="" loading="lazy" style="width:100%; aspect-ratio:4 / 3; object-fit:cover; border-radius:6px; background:var(--surface-2); display:block;" />
      <p class="subtitle" style="font-size:11.5px; margin:6px 0;">${url ? 'Your picture' : escapeHtml(note)}</p>
      <label class="button secondary" style="display:inline-block; margin:0; font-size:12px; padding:6px 10px; cursor:pointer; border:1px solid var(--border); border-radius:6px;">
        ${url ? 'Change picture' : 'Choose a picture'}<input type="file" class="pp-file" accept="image/*" style="display:none;" />
      </label>
      ${url ? '<button type="button" class="link-quiet pp-clear" style="background:none; border:none; padding:0; margin-left:8px; font-size:12px; cursor:pointer;">Use the built-in picture</button>' : ''}
      <div class="pp-msg" style="font-size:12px;"></div>
    </div>`;

  function render() {
    card.innerHTML = `
      <h2>Proposal pictures</h2>
      <p class="subtitle" style="margin-bottom:10px;">Saved as soon as you choose a picture. A wide picture works best.</p>
      <h3 style="font-size:14px; margin:0 0 8px;">Front page, one for each proposal type</h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px;">
        ${PROPOSAL_PICTURE_TYPES.map(t => tile(t.key, t.label, covers[t.key], t.builtIn || PROPOSAL_PICTURE_BUILT_IN, 'Built-in picture')).join('')}
      </div>
      <h3 style="font-size:14px; margin:16px 0 8px;">Beside About Thomson Energy, on every proposal</h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px;">
        ${tile('about', 'About Thomson Energy', about, ABOUT_PICTURE_BUILT_IN, 'Built-in pictures (one of six)')}
      </div>`;
    card.querySelectorAll('.pp-tile').forEach(el => {
      const id = el.dataset.id;
      const msg = el.querySelector('.pp-msg');
      // one picture's change: saved on its own, so a failed save never loses another box's picture
      const save = async (url) => {
        const nextCovers = { ...covers };
        if (id !== 'about') { if (url) nextCovers[id] = url; else delete nextCovers[id]; }
        const fields = id === 'about' ? { about_photo_url: url || null } : { proposal_cover_photos: nextCovers };
        const { error } = await supabaseClient.from('company_settings').update(fields).eq('id', 1);
        if (error) throw error;
        if (id === 'about') about = url || ''; else covers = nextCovers;
      };
      el.querySelector('.pp-file').addEventListener('change', async (e) => {
        if (!e.target.files.length) return;
        msg.innerHTML = '<p class="subtitle" style="margin:6px 0 0;">Uploading...</p>';
        try {
          const [url] = await uploadPhotos(e.target.files, 'proposal-pictures');
          await save(url);
          render();
          showToast('Proposal picture saved.');
        } catch (err) {
          msg.innerHTML = `<div class="error-box" style="margin-top:6px;">${escapeHtml(friendlyError(err))}</div>`;
        }
      });
      const clear = el.querySelector('.pp-clear');
      if (clear) clear.addEventListener('click', async () => {
        try { await save(''); render(); showToast('Back to the built-in picture.'); }
        catch (err) { msg.innerHTML = `<div class="error-box" style="margin-top:6px;">${escapeHtml(friendlyError(err))}</div>`; }
      });
    });
  }
  render();
}
