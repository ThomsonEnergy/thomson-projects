// The site inspection page (site-inspection.html?id=, item 112). Loaded by that page only.
//
// Every question and photo on the checklist is a suggestion: nothing blocks Submit. Three columns
// on a laptop (Photos, Questions, Notes and tasks), stacked on a phone.
//   Photos     any number under each suggested label, plus "Add photo" with a label of its own
//   Questions  Yes or No, a choice or a short answer, each with an optional one line note
//   Notes      one box, saved as typed
//   Tasks      suggested by an answer (the item's task_when and task_text) or typed here
// Submit calls submit_site_inspection(): the inspection is marked done and, on a quote or job, its
// photos land in the Photos tab named by their label, the ticked tasks are made, the notes go to
// the quote's Internal notes and matching answers fill blank pre-quote answers. An inspection on a
// lead lands when the quote is made from the lead (a database trigger). Pressing Submit again
// later sends only what is new.
//
// Reads: site_inspections, inspection_checklist_templates, inspection_checklist_items.
// Writes: site_inspection_answers, site_inspection_photos, site_inspections (status, notes, tasks),
// the site-photos bucket. Needs supabase-client.js (supabaseClient, escapeHtml, friendlyError,
// uploadPhotosBatch, openPhotoLightbox, showToast, projectRef).

const SI = { id: null, uid: null, insp: null, items: [], answers: {}, photos: [], busy: {} };

const siIsPhoto = (it) => it.item_type === 'photo';
const siOptions = (it) => (Array.isArray(it.options) ? it.options : []);

// What a question holds, as the words a person picked or typed ('' when not answered).
function siAnswerText(it) {
  const a = SI.answers[it.id];
  if (!a) return '';
  if (it.item_type === 'yes_no') return a.answer_yes_no === true ? 'Yes' : a.answer_yes_no === false ? 'No' : '';
  return String(a.answer_text || '').trim();
}

// The task an answer suggests, or '' when this answer suggests none.
function siSuggestedTask(it) {
  if (!it.task_text || !it.task_when) return '';
  const value = siAnswerText(it);
  if (!value) return '';
  if (it.task_when === 'answered') return `${it.task_text}: ${value}`;
  return value === it.task_when ? it.task_text : '';
}

async function siMarkStarted() {
  if (SI.insp.status !== 'scheduled') return;
  await supabaseClient.from('site_inspections').update({ status: 'in_progress' }).eq('id', SI.id);
  SI.insp.status = 'in_progress';
}

async function siSaveAnswer(itemId, fields) {
  const row = { inspection_id: SI.id, item_id: itemId, answered_by: SI.uid, answered_at: new Date().toISOString(), ...fields };
  const { data, error } = await supabaseClient.from('site_inspection_answers').upsert(row, { onConflict: 'inspection_id,item_id' }).select().single();
  if (error) throw error;
  SI.answers[itemId] = data;
  await siMarkStarted();
}

async function siSaveTasks() {
  const { error } = await supabaseClient.from('site_inspections').update({ tasks: SI.insp.tasks }).eq('id', SI.id);
  if (error) throw error;
}

// Keeps the suggested task for one question in step with its answer. A task already made on the
// job is never touched.
async function siSyncTaskFor(it) {
  const tasks = SI.insp.tasks || [];
  const want = siSuggestedTask(it);
  const at = tasks.findIndex((t) => t.item_id === it.id && !t.created);
  if (want && at < 0 && !tasks.some((t) => t.item_id === it.id)) tasks.push({ text: want, ticked: true, item_id: it.id });
  else if (want && at >= 0) tasks[at].text = want;
  else if (!want && at >= 0) tasks.splice(at, 1);
  else return;
  SI.insp.tasks = tasks;
  await siSaveTasks();
  siDrawTasks();
}

// ---------------------------------------------------------------- photos
function siPhotoThumb(p) {
  return `<span class="si-thumb" data-photo="${p.id}">
    <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.label)}" loading="lazy" />
    ${p.landed_at ? '' : '<button type="button" class="si-thumb-x" title="Remove">&times;</button>'}
  </span>`;
}

function siDrawPhotos() {
  const el = document.getElementById('si-photos');
  const photoItems = SI.items.filter(siIsPhoto);
  const itemIds = new Set(photoItems.map((it) => it.id));
  const others = SI.photos.filter((p) => !p.item_id || !itemIds.has(p.item_id));
  const row = (key, label, desc, photos) => `
    <div class="si-row ${photos.length ? 'done' : ''}" data-key="${escapeHtml(key)}">
      <div class="si-row-head">
        <div><strong>${escapeHtml(label)}</strong>${desc ? `<div class="subtitle" style="font-size:12px;">${escapeHtml(desc)}</div>` : ''}</div>
        <label class="btn secondary si-add ${SI.busy[key] ? 'is-loading' : ''}">&#128247; ${photos.length ? 'More' : 'Photo'}<input type="file" accept="image/*" multiple style="display:none;" ${SI.busy[key] ? 'disabled' : ''} /></label>
      </div>
      ${photos.length ? `<div class="si-thumbs">${photos.map(siPhotoThumb).join('')}</div>` : ''}
      <div class="si-row-msg">${SI.busy[key] === 'error' ? '' : SI.busy[key] ? '<span class="subtitle">Uploading...</span>' : ''}</div>
    </div>`;
  const labels = [...new Set(others.map((p) => p.label))];
  el.innerHTML = photoItems.map((it) => row(it.id, it.label, it.description, SI.photos.filter((p) => p.item_id === it.id))).join('')
    + labels.map((l) => row('other:' + l, l, '', others.filter((p) => p.label === l))).join('')
    + `<div class="si-row" data-key="new">
        <div class="si-row-head">
          <input id="si-new-label" placeholder="Anything else: type what it is" list="si-labels" style="flex:1; min-width:0;" />
          <label class="btn si-add ${SI.busy.new ? 'is-loading' : ''}">&#128247; Add photo<input type="file" accept="image/*" multiple style="display:none;" ${SI.busy.new ? 'disabled' : ''} /></label>
        </div>
        <datalist id="si-labels">${[...new Set(SI.items.map((it) => it.label))].map((l) => `<option value="${escapeHtml(l)}"></option>`).join('')}</datalist>
        <div class="si-row-msg" id="si-new-msg"></div>
      </div>`;

  el.querySelectorAll('.si-row').forEach((rowEl) => {
    const key = rowEl.dataset.key;
    const input = rowEl.querySelector('input[type="file"]');
    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      const item = SI.items.find((it) => it.id === key);
      const label = item ? item.label : key.startsWith('other:') ? key.slice(6) : document.getElementById('si-new-label').value.trim();
      if (!label) { document.getElementById('si-new-msg').innerHTML = '<div class="error-box">Type what the photo is of first.</div>'; input.value = ''; return; }
      await siAddPhotos(key, item ? item.id : null, label, Array.from(input.files));
    });
    rowEl.querySelectorAll('.si-thumb').forEach((thumb) => {
      const photo = SI.photos.find((p) => p.id === thumb.dataset.photo);
      thumb.querySelector('img').addEventListener('click', () => {
        const group = SI.photos.filter((p) => (photo.item_id ? p.item_id === photo.item_id : !p.item_id && p.label === photo.label));
        openPhotoLightbox(group.map((p) => p.url), group.indexOf(photo));
      });
      const x = thumb.querySelector('.si-thumb-x');
      if (x) x.addEventListener('click', async () => {
        if (!confirm(`Remove this photo of ${photo.label}?`)) return;
        const { error } = await supabaseClient.from('site_inspection_photos').delete().eq('id', photo.id);
        if (error) { showToast(friendlyError(error), { error: true }); return; }
        SI.photos = SI.photos.filter((p) => p.id !== photo.id);
        siDrawPhotos(); siDrawSummary();
      });
    });
  });
}

async function siAddPhotos(key, itemId, label, files) {
  SI.busy[key] = true; siDrawPhotos();
  let failedCount = 0;
  try {
    const { urls, failed } = await uploadPhotosBatch(files, `inspections/${SI.id}`, 'site-photos');
    failedCount = failed.length;
    if (urls.length) {
      const rows = urls.map((url) => ({ inspection_id: SI.id, item_id: itemId, label, url, taken_by: SI.uid }));
      const { data, error } = await supabaseClient.from('site_inspection_photos').insert(rows).select();
      if (error) throw error;
      SI.photos.push(...(data || []));
      await siMarkStarted();
    }
  } catch (err) {
    showToast('Photo not saved. ' + friendlyError(err), { error: true });
  }
  delete SI.busy[key];
  if (failedCount) showToast(`${failedCount} photo${failedCount === 1 ? '' : 's'} did not upload. Try again.`, { error: true });
  siDrawPhotos(); siDrawSummary();
}

// ---------------------------------------------------------------- questions
function siDrawQuestions() {
  const el = document.getElementById('si-questions');
  const questions = SI.items.filter((it) => !siIsPhoto(it));
  if (!questions.length) { el.innerHTML = '<p class="subtitle">No questions on this checklist.</p>'; return; }
  el.innerHTML = questions.map((it) => {
    const a = SI.answers[it.id] || {};
    const value = siAnswerText(it);
    const control = it.item_type === 'yes_no'
      ? ['Yes', 'No'].map((v) => `<button type="button" class="secondary si-yn ${value === v ? 'selected' : ''}" data-v="${v}">${v}</button>`).join('')
      : it.item_type === 'choice'
        ? `<select class="si-choice"><option value="">Not answered</option>${siOptions(it).map((o) => `<option ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`
        : `<input class="si-text" value="${escapeHtml(value)}" placeholder="Type the answer" />`;
    return `
      <div class="si-row ${value ? 'done' : ''}" data-item="${it.id}">
        <div class="si-row-head si-q">
          <div><strong>${escapeHtml(it.label)}</strong>${it.description ? `<div class="subtitle" style="font-size:12px;">${escapeHtml(it.description)}</div>` : ''}</div>
          <div class="si-control">${control}<button type="button" class="secondary si-note-btn" title="Add a note" ${a.note ? 'style="display:none;"' : ''}>+ note</button></div>
        </div>
        <input class="si-note" value="${escapeHtml(a.note || '')}" placeholder="Note" ${a.note ? '' : 'style="display:none;"'} />
        <div class="si-row-msg"></div>
      </div>`;
  }).join('');

  el.querySelectorAll('.si-row').forEach((rowEl) => {
    const it = SI.items.find((i) => i.id === rowEl.dataset.item);
    // Only this row is touched after a save: drawing the column again would wipe what is being
    // typed in the next box and close an open note.
    const save = async (fields) => {
      const msg = rowEl.querySelector('.si-row-msg');
      try {
        await siSaveAnswer(it.id, fields);
        msg.innerHTML = '';
        await siSyncTaskFor(it);
      } catch (err) {
        msg.innerHTML = `<div class="error-box">Not saved. ${escapeHtml(friendlyError(err))}</div>`;
      }
      const value = siAnswerText(it);
      rowEl.classList.toggle('done', !!value);
      rowEl.querySelectorAll('.si-yn').forEach((b) => b.classList.toggle('selected', b.dataset.v === value));
      siDrawSummary();
    };
    rowEl.querySelectorAll('.si-yn').forEach((btn) => btn.addEventListener('click', () => {
      const v = btn.dataset.v === 'Yes';
      // tapping the answer already picked clears it
      save({ answer_yes_no: (SI.answers[it.id] || {}).answer_yes_no === v ? null : v });
    }));
    const choice = rowEl.querySelector('.si-choice');
    if (choice) choice.addEventListener('change', () => save({ answer_text: choice.value || null }));
    const text = rowEl.querySelector('.si-text');
    if (text) text.addEventListener('change', () => save({ answer_text: text.value.trim() || null }));
    const note = rowEl.querySelector('.si-note');
    rowEl.querySelector('.si-note-btn').addEventListener('click', (e) => { e.currentTarget.style.display = 'none'; note.style.display = ''; note.focus(); });
    note.addEventListener('change', () => save({ note: note.value.trim() || null }));
  });
}

// ---------------------------------------------------------------- notes and tasks
function siDrawTasks() {
  const el = document.getElementById('si-tasks');
  const tasks = SI.insp.tasks || [];
  el.innerHTML = (tasks.length ? tasks.map((t, i) => `
    <label class="si-task">
      <input type="checkbox" data-i="${i}" ${t.ticked ? 'checked' : ''} ${t.created ? 'disabled' : ''} style="width:auto;" />
      <span>${escapeHtml(t.text)}${t.created ? ' <span class="subtitle" style="font-size:12px;">(on the job)</span>' : ''}</span>
      ${t.created ? '' : `<button type="button" class="si-thumb-x" data-i="${i}" title="Remove" style="position:static;">&times;</button>`}
    </label>`).join('') : '<p class="subtitle" style="margin:0 0 6px;">None yet. An answer can suggest one, or type your own.</p>')
    + `<div style="display:flex; gap:6px; margin-top:6px;"><input id="si-task-new" placeholder="Add a task" style="flex:1; min-width:0;" /><button type="button" class="secondary" id="si-task-add" style="width:auto;">Add</button></div>`;
  const change = async (fn) => {
    fn();
    try { await siSaveTasks(); } catch (err) { showToast('Task not saved. ' + friendlyError(err), { error: true }); }
    siDrawTasks(); siDrawSummary();
  };
  el.querySelectorAll('input[type="checkbox"]').forEach((c) => c.addEventListener('change', () => change(() => { tasks[Number(c.dataset.i)].ticked = c.checked; })));
  el.querySelectorAll('.si-thumb-x').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); change(() => { tasks.splice(Number(b.dataset.i), 1); }); }));
  const add = () => {
    const text = el.querySelector('#si-task-new').value.trim();
    if (text) change(() => { tasks.push({ text, ticked: true }); SI.insp.tasks = tasks; });
  };
  el.querySelector('#si-task-add').addEventListener('click', add);
  el.querySelector('#si-task-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
}

// What Submit will send, what was skipped, and the button's words.
function siDrawSummary() {
  const skipped = SI.items.filter((it) => (siIsPhoto(it) ? !SI.photos.some((p) => p.item_id === it.id) : !siAnswerText(it)));
  const newPhotos = SI.photos.filter((p) => !p.landed_at).length;
  const newTasks = (SI.insp.tasks || []).filter((t) => t.ticked && !t.created).length;
  const done = SI.insp.status === 'completed';
  const btn = document.getElementById('si-submit');
  btn.textContent = done ? (newPhotos || newTasks ? 'Send what is new' : 'Submitted') : 'Submit';
  btn.disabled = done && !newPhotos && !newTasks && !!SI.insp.landed_project_id;
  document.getElementById('si-status').innerHTML = `<span class="badge ${done ? 'accepted' : 'sent'}">${escapeHtml(SI.insp.status.replace('_', ' '))}</span>`;
  const where = SI.insp.project_id ? 'the quote or job' : 'the quote, once it is made from this lead';
  document.getElementById('si-summary').innerHTML = `
    <p class="subtitle" style="margin:0 0 6px; font-size:12px;">Submit sends ${newPhotos} photo${newPhotos === 1 ? '' : 's'} and ${newTasks} task${newTasks === 1 ? '' : 's'} to ${where}. Nothing here is required.</p>
    ${skipped.length ? `<details><summary class="subtitle" style="font-size:12px; cursor:pointer;">Not done: ${skipped.length} of ${SI.items.length}</summary><div style="font-size:12px; margin-top:4px;">${skipped.map((it) => escapeHtml(it.label)).join(', ')}</div></details>` : '<p class="subtitle" style="margin:0; font-size:12px;">Everything on the list is done.</p>'}`;
}

async function siSubmit() {
  const btn = document.getElementById('si-submit');
  const msg = document.getElementById('si-submit-msg');
  btn.disabled = true; btn.textContent = 'Sending...'; msg.innerHTML = '';
  try {
    // the notes box saves on change; make sure what is typed right now is in before it lands
    const notes = document.getElementById('si-notes').value.trim() || null;
    const { error: notesErr } = await supabaseClient.from('site_inspections').update({ notes }).eq('id', SI.id);
    if (notesErr) throw notesErr;
    const { data, error } = await supabaseClient.rpc('submit_site_inspection', { p_inspection_id: SI.id });
    if (error) throw error;
    showToast(data && data.landed
      ? `Submitted: ${data.photos} photo${data.photos === 1 ? '' : 's'} and ${data.tasks} task${data.tasks === 1 ? '' : 's'} added.`
      : 'Submitted. It goes onto the quote when the quote is made from this lead.');
    await siLoad();
  } catch (err) {
    msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    siDrawSummary();
  }
}

// ---------------------------------------------------------------- load
async function siLoad() {
  const content = document.getElementById('content');
  const { data: insp, error } = await supabaseClient
    .from('site_inspections')
    .select('*, inspection_checklist_templates(name), leads(name, address_formatted), projects(name, job_number, quote_number, client_name, client_address)')
    .eq('id', SI.id).single();
  if (error || !insp) { content.innerHTML = '<div class="error-box">Could not load this inspection.</div>'; return; }
  SI.insp = insp;
  SI.insp.tasks = Array.isArray(insp.tasks) ? insp.tasks : [];
  const templateIds = [insp.template_id, ...(insp.extra_template_ids || [])];
  const [{ data: items }, { data: answers }, { data: photos }, { data: extras }] = await Promise.all([
    supabaseClient.from('inspection_checklist_items').select('*').in('template_id', templateIds).order('sort_order'),
    supabaseClient.from('site_inspection_answers').select('*').eq('inspection_id', SI.id),
    supabaseClient.from('site_inspection_photos').select('*').eq('inspection_id', SI.id).order('created_at'),
    (insp.extra_template_ids || []).length
      ? supabaseClient.from('inspection_checklist_templates').select('id, name').in('id', insp.extra_template_ids)
      : Promise.resolve({ data: [] }),
  ]);
  // the first checklist's items first, then each extra list's, each in its own order
  // (a photo or question two lists both have, such as the switchboard, is asked once)
  const seen = new Set();
  SI.items = (items || []).slice()
    .sort((a, b) => templateIds.indexOf(a.template_id) - templateIds.indexOf(b.template_id) || a.sort_order - b.sort_order)
    .filter((it) => { const key = it.item_type + '|' + it.label.trim().toLowerCase(); return !seen.has(key) && seen.add(key); });
  SI.answers = {};
  (answers || []).forEach((a) => { SI.answers[a.item_id] = a; });
  SI.photos = photos || [];

  const subject = insp.leads
    ? `${insp.leads.name || 'Lead'}${insp.leads.address_formatted ? ', ' + insp.leads.address_formatted : ''}`
    : `${projectRef(insp.projects)}${insp.projects && insp.projects.client_address ? ', ' + insp.projects.client_address : ''}`;
  const lists = [insp.inspection_checklist_templates && insp.inspection_checklist_templates.name, ...(extras || []).map((t) => t.name)].filter(Boolean).join(' + ');
  const back = insp.lead_id ? '/leads.html' : `/project.html?id=${insp.project_id}`;

  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 style="font-size:18px;"><a class="link-quiet" href="${back}">&larr;</a> Site inspection <span id="si-status"></span></h1>
        <p class="subtitle">${escapeHtml(subject)} &middot; ${escapeHtml(lists || 'Checklist')}</p>
      </div>
      <button type="button" id="si-submit" style="width:auto;">Submit</button>
    </div>
    <div id="si-submit-msg"></div>
    <div class="page-cols">
      <div class="page-col"><div class="card"><h2>Photos</h2><div id="si-photos"></div></div></div>
      <div class="page-col"><div class="card"><h2>Questions</h2><div id="si-questions"></div></div></div>
      <div class="page-col">
        <div class="card"><h2>Notes</h2><textarea id="si-notes" style="min-height:120px;" placeholder="Anything worth writing down from the visit">${escapeHtml(insp.notes || '')}</textarea><div id="si-notes-msg"></div></div>
        <div class="card"><h2>Tasks</h2><p class="subtitle" style="margin:0 0 6px; font-size:12px;">Ticked tasks are added to the quote or job on Submit, for whoever booked this inspection.</p><div id="si-tasks"></div></div>
        <div class="card"><div id="si-summary"></div></div>
      </div>
    </div>`;

  const notes = document.getElementById('si-notes');
  notes.addEventListener('change', async () => {
    const { error: err } = await supabaseClient.from('site_inspections').update({ notes: notes.value.trim() || null }).eq('id', SI.id);
    document.getElementById('si-notes-msg').innerHTML = err ? `<div class="error-box">Not saved. ${escapeHtml(friendlyError(err))}</div>` : '<span class="subtitle" style="font-size:12px;">Saved</span>';
    if (!err) await siMarkStarted();
  });
  document.getElementById('si-submit').addEventListener('click', siSubmit);
  siDrawPhotos(); siDrawQuestions(); siDrawTasks(); siDrawSummary();
}

async function initSiteInspection(inspectionId, userId) {
  SI.id = inspectionId; SI.uid = userId;
  await siLoad();
}
