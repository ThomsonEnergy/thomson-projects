// Settings > Company Details > Product pictures (backlog item 73c): a picture of each inverter
// and battery the business quotes, best with a clear background (the makers' media kits have
// them as PNG files). The picture editor on step 4 of a quote (js/photo-compose.js) offers them
// to place on the client's own wall picture, the quote's makes first.
//
// Who calls it: settings.html, loadSettings(), as loadProductPicturesCard(). Reads and writes the
// product_pictures table (Admin writes, migration 20261201020000); pictures go to the
// proposal-photos bucket through uploadPhotos(), which keeps a PNG's clear background. Every
// change saves itself: there is no Save to press.

async function loadProductPicturesCard() {
  const card = document.getElementById('product-pictures-card');
  if (!card) return;
  let rows = [];
  let note = '';
  const CHECKER = 'repeating-conic-gradient(#d9d9d9 0% 25%, #f4f4f4 0% 50%) 50% / 16px 16px';

  async function load() {
    const { data, error } = await supabaseClient.from('product_pictures').select('id, brand, model, url').order('brand').order('model');
    if (error) return false; // the table arrives with migration 20261201020000
    rows = data || [];
    return true;
  }

  function render() {
    card.innerHTML = `
      <h2>Product pictures</h2>
      <p class="subtitle" style="margin-bottom:10px;">A picture of each inverter and battery you quote. On a quote's step 4, "Put equipment on this picture" offers them to place on the client's own wall. Best is the maker's picture with a clear background (a PNG from their media kit); an ordinary photo works too and is cut out in the editor. Saved as you go.</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px;">
        ${rows.map(r => `
          <div class="prp-tile" data-id="${escapeHtml(r.id)}" style="border:1px solid var(--border); border-radius:8px; padding:10px;">
            <img src="${escapeHtml(supaImageVariant(r.url, 400, 70))}" alt="" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:contain; border-radius:6px; background:${CHECKER}; display:block;" />
            <input type="text" class="prp-brand" maxlength="60" placeholder="Make, e.g. Sigenergy" value="${escapeHtml(r.brand)}" style="margin:8px 0 6px;" />
            <input type="text" class="prp-model" maxlength="80" placeholder="Model, e.g. SigenStor 10 kWh" value="${escapeHtml(r.model)}" style="margin:0 0 6px;" />
            <button type="button" class="link-quiet prp-remove" style="background:none; border:none; padding:0; min-height:0; color:var(--link); font-size:12px; cursor:pointer;">Remove</button>
          </div>`).join('')}
      </div>
      ${rows.length ? '' : '<p class="subtitle" style="margin:0 0 4px; font-size:12.5px;">No product pictures yet.</p>'}
      <div style="margin-top:12px;">
        <label style="display:inline-block; margin:0; font-weight:600; font-size:13px; padding:8px 12px; cursor:pointer; border:1px solid var(--border); border-radius:8px;">Add product pictures<input type="file" id="prp-file" accept="image/*" multiple style="display:none;" /></label>
      </div>
      <div id="prp-msg" style="font-size:12px; min-height:18px; margin-top:6px;">${note}</div>`;
    const msg = card.querySelector('#prp-msg');
    const fail = (err) => { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; };

    card.querySelector('#prp-file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      msg.innerHTML = `<span class="subtitle">Uploading ${files.length} picture${files.length === 1 ? '' : 's'}...</span>`;
      const { data: { session } } = await supabaseClient.auth.getSession();
      let added = 0;
      const failed = [];
      // one at a time, and a picture that fails does not stop the rest
      for (const file of files) {
        try {
          const [url] = await uploadPhotos([file], 'product-pictures');
          if (!url) throw new Error('It did not upload.');
          // the file's name is the best first guess at the model: the person tidies it in the box
          const model = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);
          const { error } = await supabaseClient.from('product_pictures').insert({ brand: '', model, url, created_by: session ? session.user.id : null });
          if (error) throw error;
          added++;
        } catch (err) { failed.push(`${file.name}: ${friendlyError(err)}`); }
      }
      note = `${added ? `<span class="subtitle">${added} picture${added === 1 ? '' : 's'} added. Type the make and model under each one.</span>` : ''}${failed.length ? `<div class="error-box" style="margin-top:6px;">${failed.length} could not be added. ${escapeHtml(failed.join(' '))}</div>` : ''}`;
      await load();
      render();
    });

    card.querySelectorAll('.prp-tile').forEach(tile => {
      const id = tile.dataset.id;
      const row = rows.find(r => r.id === id);
      const saveText = async (field, input) => {
        const value = input.value.trim();
        if (value === row[field]) return;
        const { error } = await supabaseClient.from('product_pictures').update({ [field]: value }).eq('id', id);
        if (error) { fail(error); return; }
        row[field] = value;
        msg.innerHTML = '<span class="subtitle">Saved.</span>';
      };
      tile.querySelector('.prp-brand').addEventListener('change', (e) => saveText('brand', e.target));
      tile.querySelector('.prp-model').addEventListener('change', (e) => saveText('model', e.target));
      tile.querySelector('.prp-remove').addEventListener('click', async () => {
        if (!confirm(`Remove this product picture${row.model ? ` (${row.model})` : ''}? Pictures already made with it stay on their quotes.`)) return;
        const { error } = await supabaseClient.from('product_pictures').delete().eq('id', id);
        if (error) { fail(error); return; }
        rows = rows.filter(r => r.id !== id);
        note = '';
        render();
      });
    });
  }

  if (!(await load())) { card.innerHTML = '<h2>Product pictures</h2><p class="subtitle">Not set up on this database yet.</p>'; return; }
  render();
}
