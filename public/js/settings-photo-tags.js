// Settings > Company Details > Picture tags (backlog item 73b): the picture tagger's switch.
// The tagger reads every picture added to a job and tags it with what is in it, so pictures can
// be searched and a quote can offer recent installs with the same gear. It starts off (a new AI
// worker starts read only): "Try it on 50 pictures" reads 50 and lists what it would tag, with
// the cost, saving nothing; "Switch on" then tags the pictures already in the app and every new
// one by itself.
//
// Who calls it: settings.html, loadSettings(), as loadPhotoTagsCard(settingsRow). Calls
// tag-photos.js one picture at a time, four at once. Writes company_settings.photo_tagging_on;
// the tags themselves are written by the function.

// What the app's AI model costs, in US dollars per million tokens in and out (Claude Sonnet 5.5,
// November 2026). Only used to show the owner a cost before anything is saved.
const PHOTO_TAG_PRICE = { input: 2, output: 10 };
const PHOTO_TAG_TRY = 50;

async function loadPhotoTagsCard(settings) {
  const card = document.getElementById('photo-tags-card');
  if (!card) return;
  let on = !!(settings && settings.photo_tagging_on);
  let running = false, stop = false;
  const usd = (n) => (n < 1 ? `US$${n.toFixed(n < 0.1 ? 3 : 2)}` : `US$${n.toFixed(2)}`);
  const costOf = (u) => (u.input_tokens * PHOTO_TAG_PRICE.input + u.output_tokens * PHOTO_TAG_PRICE.output) / 1e6;

  const counts = async () => {
    const [all, todo, failed] = await Promise.all([
      supabaseClient.from('project_photos').select('id', { count: 'exact', head: true }),
      supabaseClient.from('project_photos').select('id', { count: 'exact', head: true }).is('tagged_at', null),
      supabaseClient.from('project_photos').select('id', { count: 'exact', head: true }).not('tagged_at', 'is', null).not('tag_note', 'is', null),
    ]);
    if (all.error || todo.error) return null; // the tags arrive with migration 20261130100000
    return { all: all.count || 0, todo: todo.count || 0, failed: failed.count || 0 };
  };

  // One picture through the function. Never throws: a failure is a result with an error.
  const readOne = async (id, save) => {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/tag-photos', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ photo_id: id, save }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) return { result: { id, error: out.error || 'Could not be read' }, usage: { input_tokens: 0, output_tokens: 0 } };
      return out;
    } catch (err) { return { result: { id, error: 'No answer: check your signal' }, usage: { input_tokens: 0, output_tokens: 0 } }; }
  };

  // Works through a list of picture ids, four at once, calling each(out) as answers come in.
  const work = async (ids, save, each) => {
    let at = 0;
    const worker = async () => { while (at < ids.length && !stop) { const id = ids[at++]; each(await readOne(id, save)); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
  };

  async function render() {
    const c = await counts();
    if (!c) { card.innerHTML = '<h2>Picture tags</h2><p class="subtitle">Not set up on this database yet.</p>'; return; }
    card.innerHTML = `
      <h2>Picture tags</h2>
      <p class="subtitle" style="margin-bottom:10px;">Every picture added to a job is read by AI and tagged with what is in it (the brand, inverter, battery, switchboard, finished install and so on). Search "Sigenergy" in the top bar or on a job's Site Photos and the pictures come up, and a quote offers recent installs with the same gear.</p>
      <p style="margin:0 0 10px; font-size:13.5px;"><strong>${on ? 'On.' : 'Off.'}</strong> ${on ? 'New pictures are tagged by themselves.' : 'Nothing is tagged or saved until you switch it on.'} ${Math.max(0, c.all - c.todo - c.failed)} of ${c.all} pictures tagged${c.failed ? `, ${c.failed} could not be read (videos, or pictures the reader could not make out)` : ''}.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${c.todo ? `<button type="button" class="secondary" id="pt-try">Try it on ${Math.min(PHOTO_TAG_TRY, c.todo)} pictures (nothing is saved)</button>` : ''}
        ${c.todo ? `<button type="button" id="pt-go">${on ? `Tag the ${c.todo} still to do` : `Switch on and tag all ${c.todo} pictures`}</button>` : (on ? '' : '<button type="button" id="pt-go">Switch on</button>')}
        ${on && c.failed ? `<button type="button" class="secondary" id="pt-again">Try the ${c.failed} again</button>` : ''}
        ${on ? '<button type="button" class="secondary" id="pt-off">Switch off</button>' : ''}
        <button type="button" class="secondary" id="pt-stop" style="display:none;">Stop</button>
      </div>
      <div id="pt-progress" style="font-size:13px; margin-top:10px;"></div>
      <div id="pt-results" style="margin-top:8px; max-height:420px; overflow:auto;"></div>`;
    const progress = card.querySelector('#pt-progress');
    const results = card.querySelector('#pt-results');
    const stopBtn = card.querySelector('#pt-stop');
    const busy = (yes) => { running = yes; stop = false; card.querySelectorAll('#pt-try, #pt-go, #pt-off, #pt-again').forEach(b => { b.disabled = yes; }); stopBtn.disabled = false; stopBtn.style.display = yes ? '' : 'none'; };
    stopBtn.addEventListener('click', () => { stop = true; stopBtn.disabled = true; });

    // the pictures still to read, newest first; the database hands back 1,000 rows at a time
    const todoIds = async (limit) => {
      const ids = [];
      while (ids.length < limit) {
        const { data, error } = await supabaseClient.from('project_photos').select('id').is('tagged_at', null).order('created_at', { ascending: false }).range(ids.length, Math.min(limit, ids.length + 1000) - 1);
        if (error) throw error;
        ids.push(...(data || []).map(p => p.id));
        if (!data || data.length < 1000) break;
      }
      return ids;
    };
    const rowHtml = (r) => `<div style="display:flex; gap:10px; padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
        ${r.url ? `<img src="${escapeHtml(supaImageVariant(r.url, 120, 60))}" alt="" loading="lazy" style="width:56px; height:56px; object-fit:cover; border-radius:6px; flex:none;" />` : ''}
        <div>${r.error ? `<span style="color:var(--red);">${escapeHtml(r.error)}</span>` : `<strong>${escapeHtml((r.tags || []).join(', ') || 'no tags')}</strong><br>${escapeHtml(r.caption || '')}${r.ok_for_proposals ? '<br><span class="subtitle">Fine to show another customer</span>' : ''}`}</div>
      </div>`;

    const tryBtn = card.querySelector('#pt-try');
    if (tryBtn) tryBtn.addEventListener('click', async () => {
      busy(true);
      results.innerHTML = '';
      const usage = { input_tokens: 0, output_tokens: 0 };
      let done = 0, failed = 0;
      try {
        const ids = await todoIds(PHOTO_TAG_TRY);
        await work(ids, false, (out) => {
          done++; if (out.result.error) failed++;
          usage.input_tokens += out.usage.input_tokens || 0; usage.output_tokens += out.usage.output_tokens || 0;
          results.insertAdjacentHTML('beforeend', rowHtml(out.result));
          progress.textContent = `Read ${done} of ${ids.length}. Nothing is saved.`;
        });
        const read = done - failed;
        const each = read ? costOf(usage) / read : 0;
        progress.innerHTML = `<strong>Read ${read} picture${read === 1 ? '' : 's'}${failed ? `, ${failed} could not be read` : ''}. Nothing was saved.</strong>${read ? ` About ${usd(each)} a picture: the ${c.todo} not yet tagged would cost about ${usd(each * c.todo)}, once. Look over the tags below, then switch it on.` : ''}`;
      } catch (err) { progress.innerHTML = `<span style="color:var(--red);">${escapeHtml(friendlyError(err))}</span>`; }
      busy(false);
    });

    const goBtn = card.querySelector('#pt-go');
    if (goBtn) goBtn.addEventListener('click', async () => {
      busy(true);
      results.innerHTML = '';
      try {
        if (!on) {
          const { error } = await supabaseClient.from('company_settings').update({ photo_tagging_on: true }).eq('id', 1);
          if (error) throw error;
          on = true;
        }
        const usage = { input_tokens: 0, output_tokens: 0 };
        let tagged = 0;
        // a read that fails stays on the list and is tried again on the next pass (3 tries a picture)
        for (let pass = 0; pass < 3 && !stop; pass++) {
          const ids = await todoIds(20000);
          if (!ids.length) break;
          let done = 0, failed = 0;
          await work(ids, true, (out) => {
            done++; if (out.result.error) failed++; else tagged++;
            usage.input_tokens += out.usage.input_tokens || 0; usage.output_tokens += out.usage.output_tokens || 0;
            progress.textContent = `${pass ? 'Trying the ones that failed again: ' : ''}${done} of ${ids.length} read${failed ? ` (${failed} to try again)` : ''}. Keep this page open, or press Stop and carry on later.`;
          });
          if (!failed) break;
        }
        showToast(stop ? 'Stopped. Press the button again to carry on.' : `Tagged ${tagged} pictures (about ${usd(costOf(usage))}).`);
      } catch (err) { showToast(friendlyError(err)); }
      busy(false);
      render();
    });

    const againBtn = card.querySelector('#pt-again');
    if (againBtn) againBtn.addEventListener('click', async () => {
      // back on the list with a clean count; the main button then reads them
      const { error } = await supabaseClient.from('project_photos').update({ tagged_at: null, tag_tries: 0, tag_note: null }).not('tagged_at', 'is', null).not('tag_note', 'is', null);
      if (error) { showToast(friendlyError(error)); return; }
      render();
    });

    const offBtn = card.querySelector('#pt-off');
    if (offBtn) offBtn.addEventListener('click', async () => {
      const { error } = await supabaseClient.from('company_settings').update({ photo_tagging_on: false }).eq('id', 1);
      if (error) { showToast(friendlyError(error)); return; }
      on = false;
      showToast('Picture tagging is off. Tags already on pictures stay.');
      render();
    });
  }
  await render();
}
