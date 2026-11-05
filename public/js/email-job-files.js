// Email and the job's files (backlog item 53).
//  In:  Save to job on the attachments of a conversation tagged to a job (job Emails tab and the
//       Inbox): a picture onto Site Photos with a caption, any file into Documents in a folder.
//       The copy is made on the server from Gmail (save-email-attachment), so size is no problem.
//  Out: Add from job in the email window (and the Inbox reply box): tick the job's documents and
//       site photos to attach to the email going out (send-gmail takes them by bucket and path).
//
//   emailSaveJobBtnsHtml(items, i)          "Save to job" button for items[i] (empty if it cannot be saved)
//   wireEmailSaveJob(root, items, opts)      wires those buttons and "Save all to job"; opts { jobs(), onSaved(kind) }
//   emailSaveJobRefresh(root, jobs)          shows or hides the buttons once the conversation's jobs are known
//   mountJobEmailAttachments(el, items, o)   the job Emails tab's attachment chips: open, save, save all
//   openJobFilePicker({ jobs, chosen, onDone })  the Add from job panel; onDone(refs) with { bucket, path, name, size, key }
// items: [{ emailId, att }] where att is one entry of emails.attachments.
// Needs supabase-client.js (supabaseClient, escapeHtml, openModal, showToast, projectRef, isVideoUrl,
// supaImageVariant, getMyRole, isPricingRole) and email-compose.js (emailSize, EMAIL_MAX_FILES, EMAIL_MAX_TOTAL).

const EMAIL_PHOTO_MIME = /^image\/(jpeg|jpg|png|webp|gif)$/i;

// Only received files (from Gmail) can be saved; files we sent already live in our storage.
const emailAttSavable = (att) => att && att.part_id !== undefined && att.part_id !== null && !att.storage;
const emailAttSaved = (att) => Array.isArray(att && att.saved_to) && att.saved_to.length > 0;

function emailSaveJobBtnsHtml(items, i) {
  const att = items[i] && items[i].att;
  if (!emailAttSavable(att)) return '';
  return `<button type="button" class="secondary email-save-job" data-sj="${i}" style="font-size:12px; padding:4px 10px;" title="Put this on the job's Site Photos or Documents">${emailAttSaved(att) ? '&#10003; On the job' : 'Save to job'}</button>`;
}

function emailSaveAllBtnHtml(items) {
  return items.filter(x => emailAttSavable(x.att)).length > 1
    ? '<button type="button" class="secondary email-save-all" style="font-size:12px; padding:4px 10px;">Save all to job</button>' : '';
}

function emailSaveJobRefresh(root, jobs) {
  if (!root) return;
  root.querySelectorAll('.email-save-job, .email-save-all').forEach(b => { b.style.display = (jobs || []).length ? '' : 'none'; });
}

function wireEmailSaveJob(root, items, opts) {
  root.querySelectorAll('.email-save-job').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSaveToJobPanel([items[Number(btn.dataset.sj)]], opts.jobs(), (kind) => {
        btn.innerHTML = '&#10003; On the job';
        if (opts.onSaved) opts.onSaved(kind);
      });
    });
  });
  root.querySelectorAll('.email-save-all').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => openSaveToJobPanel(items.filter(x => emailAttSavable(x.att)), opts.jobs(), (kind) => {
      root.querySelectorAll('.email-save-job').forEach(b => { if (emailAttSaved(items[Number(b.dataset.sj)].att)) b.innerHTML = '&#10003; On the job'; });
      if (opts.onSaved) opts.onSaved(kind);
    }));
  });
  emailSaveJobRefresh(root, opts.jobs());
}

async function emailSaveAttachmentPost(body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/save-email-attachment', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error(`Could not save it (status ${res.status}). Try again.`); }
  if (!data.ok) throw new Error(data.error || 'Could not save it.');
  return data;
}

// One attachment: pick Site Photos (caption) or Documents (folder, file name). Several ("Save all"):
// pictures to Site Photos, the rest into one folder, each under its own file name.
async function openSaveToJobPanel(items, jobs, onSaved) {
  if (!jobs || !jobs.length) { alert('Tag this conversation to a job first.'); return; }
  const one = items.length === 1 ? items[0].att : null;
  const isPic = (a) => EMAIL_PHOTO_MIME.test(a.mime || '');
  const already = items.filter(x => emailAttSaved(x.att)).length;
  const baseName = one ? String(one.name || 'file') : '';
  const overlay = openModal(`
    <h2 style="margin-top:0;">${one ? 'Save to job' : `Save ${items.length} attachments to the job`}</h2>
    <p class="subtitle" style="margin:0 0 8px; font-size:12px;">${one ? `${escapeHtml(baseName)}${one.size ? ' (' + emailSize(one.size) + ')' : ''}` : 'Pictures go on Site Photos, other files into Documents, each under its own file name.'}</p>
    ${already ? `<div class="error-box" style="background:transparent; margin:0 0 8px;">${one ? 'This is already on the job. Saving again makes a second copy.' : `${already} of these ${already === 1 ? 'is' : 'are'} already on the job and will be skipped.`}</div>` : ''}
    ${jobs.length > 1 ? `<label style="margin-top:0;">Job</label><select id="sj-job">${jobs.map(j => `<option value="${j.id}">${escapeHtml(j.label || '')}</option>`).join('')}</select>` : `<p style="margin:0 0 4px;"><strong>${escapeHtml(jobs[0].label || 'This job')}</strong></p>`}
    ${one ? `<label>Put it on</label>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400;"><input type="radio" name="sj-to" value="photos" ${isPic(one) ? 'checked' : 'disabled'} style="width:auto;" /> Site Photos${isPic(one) ? '' : ' (pictures only)'}</label>
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400;"><input type="radio" name="sj-to" value="documents" ${isPic(one) ? '' : 'checked'} style="width:auto;" /> Documents</label>
      </div>
      <label id="sj-label-l">Caption</label>
      <input id="sj-label" value="${escapeHtml(isPic(one) ? baseName.replace(/\.[^.]+$/, '') : baseName)}" />` : ''}
    <div id="sj-folder-wrap"><label>Folder</label><select id="sj-folder"><option>Emails</option></select>
      <input id="sj-new-folder" placeholder="New folder name" style="display:none; margin-top:6px;" /></div>
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="sj-save">Save</button><button type="button" class="secondary" id="sj-cancel">Cancel</button></div>
    <div id="sj-msg" style="margin-top:8px;"></div>`, { maxWidth: 460, zIndex: 130 });
  const q = (s) => overlay.querySelector(s);
  const jobId = () => (q('#sj-job') ? q('#sj-job').value : jobs[0].id);
  const to = () => (one ? overlay.querySelector('input[name="sj-to"]:checked').value : 'mixed');
  const folderSel = q('#sj-folder');

  const loadFolders = async () => {
    const [{ data }, role] = await Promise.all([supabaseClient.from('project_documents').select('folder').eq('project_id', jobId()), getMyRole()]);
    const names = [...new Set(['Emails', ...(data || []).map(d => d.folder).filter(Boolean)])]
      .filter(f => f !== 'Electricity bill' || isPricingRole(role)).sort((a, b) => (a === 'Emails' ? -1 : b === 'Emails' ? 1 : a.localeCompare(b)));
    folderSel.innerHTML = names.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('') + '<option value="__new">+ New folder</option>';
  };
  const showFolder = () => {
    q('#sj-folder-wrap').style.display = to() === 'photos' ? 'none' : '';
    if (one) {
      q('#sj-label-l').textContent = to() === 'photos' ? 'Caption' : 'File name';
      const lbl = q('#sj-label');
      if (to() === 'documents' && lbl.value === baseName.replace(/\.[^.]+$/, '')) lbl.value = baseName;
      if (to() === 'photos' && lbl.value === baseName) lbl.value = baseName.replace(/\.[^.]+$/, '');
    }
  };
  folderSel.addEventListener('change', () => { q('#sj-new-folder').style.display = folderSel.value === '__new' ? '' : 'none'; });
  overlay.querySelectorAll('input[name="sj-to"]').forEach(r => r.addEventListener('change', showFolder));
  if (q('#sj-job')) q('#sj-job').addEventListener('change', loadFolders);
  q('#sj-cancel').addEventListener('click', () => overlay.remove());
  showFolder();
  loadFolders();

  q('#sj-save').addEventListener('click', async () => {
    const btn = q('#sj-save'), msg = q('#sj-msg');
    const folder = folderSel.value === '__new' ? q('#sj-new-folder').value.trim() : folderSel.value;
    if (to() !== 'photos' && !folder) { msg.innerHTML = '<div class="error-box">Name the new folder.</div>'; return; }
    const todo = one ? items : items.filter(x => !emailAttSaved(x.att));
    if (!todo.length) { overlay.remove(); return; }
    btn.disabled = true;
    const kinds = new Set();
    let done = 0;
    try {
      for (const x of todo) {
        btn.textContent = todo.length > 1 ? `Saving ${done + 1} of ${todo.length}...` : 'Saving...';
        const dest = one ? to() : (isPic(x.att) ? 'photos' : 'documents');
        const r = await emailSaveAttachmentPost({ email_id: x.emailId, part_id: x.att.part_id, project_id: jobId(), to: dest, label: one ? q('#sj-label').value.trim() : '', folder });
        x.att.saved_to = [...(x.att.saved_to || []), { project_id: jobId(), kind: r.kind, id: r.id }];
        kinds.add(r.kind); done += 1;
      }
      overlay.remove();
      showToast(done === 1 ? (kinds.has('photo') ? 'Saved to Site Photos' : 'Saved to Documents') : `${done} saved to the job`);
      kinds.forEach(k => onSaved && onSaved(k));
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${done ? `${done} saved, then: ` : ''}${escapeHtml(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Save';
      kinds.forEach(k => onSaved && onSaved(k));
    }
  });
}

// The job Emails tab: one row of chips per conversation. Tap a chip to open the file; Save to job
// beside each; Save all when there are several. items: [{ emailId, att }].
function mountJobEmailAttachments(el, items, { project, ctx, onSaved }) {
  if (!el || !items.length) return;
  el.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; align-items:center;';
  el.innerHTML = items.map((x, i) => `<span style="display:inline-flex; gap:4px;"><button type="button" class="secondary job-email-att" data-i="${i}" style="font-size:12px; padding:4px 10px;">&#128206; ${escapeHtml(x.att.name)}</button>${emailSaveJobBtnsHtml(items, i)}</span>`).join('') + emailSaveAllBtnHtml(items);
  el.querySelectorAll('.job-email-att').forEach(btn => btn.addEventListener('click', async () => {
    const x = items[Number(btn.dataset.i)];
    const original = btn.innerHTML; btn.disabled = true; btn.textContent = 'Opening...';
    await emailOpenAttachment(x.emailId, x.att, ctx);
    btn.disabled = false; btn.innerHTML = original;
  }));
  wireEmailSaveJob(el, items, { jobs: () => [{ id: project.id, label: projectRef(project) }], onSaved });
}

// ---------- Add from job ----------

// The job's documents and site photos as attachment refs, with sizes from storage where it says.
async function emailJobFiles(projectId) {
  const [{ data: job }, { data: docs }, { data: photos }] = await Promise.all([
    supabaseClient.from('projects').select('id, name, job_number, quote_number').eq('id', projectId).maybeSingle(),
    supabaseClient.from('project_documents').select('id, folder, file_path, file_name, created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabaseClient.from('project_photos').select('id, url, caption, created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
  ]);
  const ref = job ? (job.job_number ? `J${job.job_number}` : job.quote_number ? `Q${job.quote_number}` : '') : '';
  const marker = '/object/public/site-photos/';
  const pics = (photos || []).filter(p => p.url && p.url.includes(marker) && !isVideoUrl(p.url)).map(p => {
    const path = decodeURIComponent(p.url.split(marker)[1].split('?')[0]);
    const ext = (path.match(/\.([a-z0-9]{2,5})$/i) || [, 'jpg'])[1].toLowerCase();
    const day = new Date(p.created_at).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric' });
    const title = String(p.caption || '').trim() || `Photo ${day}`;
    const name = `${ref ? ref + ' - ' : ''}${title}`.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) + '.' + ext;
    return { key: 'site-photos:' + path, bucket: 'site-photos', path, name, day, thumb: supaImageVariant(p.url, 240, 60), size: 0 };
  });
  const files = (docs || []).map(d => ({ key: 'project-documents:' + d.file_path, bucket: 'project-documents', path: d.file_path, name: d.file_name, folder: d.folder || 'General', size: 0 }));
  // sizes: list each folder the files sit in (best effort; the server checks the real total)
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const lists = [...new Set(files.map(f => 'project-documents|' + dirOf(f.path)))].slice(0, 8);
  if (pics.length) lists.push('site-photos|' + projectId);
  const sizes = {};
  await Promise.all(lists.map(async (k) => {
    const [bucket, dir] = k.split('|');
    try {
      const { data } = await supabaseClient.storage.from(bucket).list(dir, { limit: 1000 });
      (data || []).forEach(o => { if (o.metadata && o.metadata.size) sizes[`${bucket}:${dir}/${o.name}`] = o.metadata.size; });
    } catch (e) { /* no size shown */ }
  }));
  [...files, ...pics].forEach(f => { f.size = sizes[f.key] || 0; });
  return { label: job ? projectRef(job) : '', files, pics };
}

// The Add from job panel, over the email window. jobs: [{ id, label? }]; chosen: refs already added.
function openJobFilePicker({ jobs, chosen, onDone }) {
  const overlay = openModal(`
    <h2 style="margin-top:0;">Add from the job</h2>
    ${jobs.length > 1 ? `<select id="jf-job" style="margin-bottom:8px;">${jobs.map(j => `<option value="${j.id}">${escapeHtml(j.label || '')}</option>`).join('')}</select>` : ''}
    <div id="jf-body"><p class="subtitle">Loading the job's documents and photos...</p></div>
    <div style="position:sticky; bottom:-16px; background:var(--surface, var(--bg)); padding:10px 0 4px; margin-top:10px; border-top:1px solid var(--border); display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <button type="button" id="jf-add">Add</button><button type="button" class="secondary" id="jf-cancel">Cancel</button>
      <span id="jf-count" class="subtitle" style="margin:0; font-size:12px;"></span>
    </div>`, { maxWidth: 640, zIndex: 130 });
  const q = (s) => overlay.querySelector(s);
  const picked = new Map((chosen || []).map(r => [r.key, r]));
  let current = { files: [], pics: [] };
  const all = () => [...current.files, ...current.pics];
  const count = () => {
    const list = [...picked.values()];
    const bytes = list.reduce((n, r) => n + (r.size || 0), 0);
    q('#jf-count').textContent = list.length ? `${list.length} ticked${bytes ? ', ' + emailSize(bytes) : ''}` : 'Tick documents or tap photos to add them.';
  };
  const toggle = (key, on) => {
    const r = all().find(x => x.key === key);
    if (!r) return;
    if (on) picked.set(key, r); else picked.delete(key);
    count();
  };
  const render = async () => {
    const body = q('#jf-body');
    body.innerHTML = '<p class="subtitle">Loading the job\'s documents and photos...</p>';
    try { current = await emailJobFiles(q('#jf-job') ? q('#jf-job').value : jobs[0].id); } catch (err) { body.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
    const folders = [...new Set(current.files.map(f => f.folder))];
    const days = [...new Set(current.pics.map(p => p.day))];
    body.innerHTML = `
      <h3 style="margin:0 0 6px; font-size:15px;">Documents</h3>
      ${folders.length ? folders.map(f => `<div style="margin-bottom:8px;"><div class="subtitle" style="font-size:12px; margin-bottom:2px;">${escapeHtml(f)}</div>
        ${current.files.filter(x => x.folder === f).map(x => `<label style="display:flex; align-items:center; gap:8px; margin:0 0 3px; font-weight:400;"><input type="checkbox" class="jf-doc" data-k="${escapeHtml(x.key)}" ${picked.has(x.key) ? 'checked' : ''} style="width:auto;" /> <span style="overflow-wrap:anywhere;">${escapeHtml(x.name)}${x.size ? ` <span style="color:var(--muted);">(${emailSize(x.size)})</span>` : ''}</span></label>`).join('')}</div>`).join('') : '<p class="subtitle" style="margin:0 0 8px;">No documents on this job.</p>'}
      <h3 style="margin:12px 0 6px; font-size:15px;">Site Photos</h3>
      ${days.length ? days.map(d => `<div class="subtitle" style="font-size:12px; margin:6px 0 4px;">${escapeHtml(d)}</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">${current.pics.filter(p => p.day === d).map(p => `<button type="button" class="jf-pic" data-k="${escapeHtml(p.key)}" title="${escapeHtml(p.name)}" style="position:relative; width:88px; height:88px; padding:0; border-radius:8px; overflow:hidden; border:3px solid ${picked.has(p.key) ? 'var(--accent)' : 'transparent'}; background:var(--border);"><img src="${escapeHtml(p.thumb)}" alt="" loading="lazy" style="width:100%; height:100%; object-fit:cover; display:block;" /><span class="jf-tick" style="position:absolute; top:3px; right:3px; background:var(--accent); color:#fff; border-radius:50%; width:20px; height:20px; font-size:13px; line-height:20px; text-align:center; display:${picked.has(p.key) ? 'block' : 'none'};">&#10003;</span></button>`).join('')}</div>`).join('') : '<p class="subtitle" style="margin:0;">No site photos on this job.</p>'}`;
    body.querySelectorAll('.jf-doc').forEach(c => c.addEventListener('change', () => toggle(c.dataset.k, c.checked)));
    body.querySelectorAll('.jf-pic').forEach(b => b.addEventListener('click', () => {
      const on = !picked.has(b.dataset.k);
      toggle(b.dataset.k, on);
      b.style.borderColor = on ? 'var(--accent)' : 'transparent';
      b.querySelector('.jf-tick').style.display = on ? 'block' : 'none';
    }));
    count();
  };
  if (q('#jf-job')) q('#jf-job').addEventListener('change', render);
  q('#jf-cancel').addEventListener('click', () => overlay.remove());
  q('#jf-add').addEventListener('click', () => {
    overlay.remove();
    onDone([...picked.values()].map(r => ({ key: r.key, bucket: r.bucket, path: r.path, name: r.name, size: r.size || 0 })));
  });
  render();
}
