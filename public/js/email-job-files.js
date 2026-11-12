// Email and the job's files (backlog item 53).
//  In:  Save to job on the attachments of a conversation tagged to a job (job Emails tab and the
//       Inbox): a picture onto Site Photos with a caption, any file into Documents in a folder.
//       The copy is made on the server from Gmail (save-email-attachment), so size is no problem.
//  Out: Add from job in the email window (and the Inbox reply box): tick the job's documents and
//       site photos to attach to the email going out (send-gmail takes them by bucket and path).
//
//   emailSaveJobBtnsHtml(items, i)          "Save to job" button for items[i] (empty if it cannot be saved)
//   wireEmailSaveJob(root, items, opts)      wires those buttons and "Save all to job"; opts { jobs(), onSaved(kind) }
//   emailSaveJobRefresh(root, jobs)          shows or hides the buttons (and says "On the job") once the jobs are known
//   openJobFilePicker({ jobs, chosen, onDone })  the Add from job panel; onDone(refs) with { bucket, path, name, size, key }
// items: [{ emailId, att }] where att is one entry of emails.attachments.
// The job Emails tab's chips are drawn by mountJobEmailAttachments (email-view.js), which adds these
// buttons once this file has loaded.
// Needs supabase-client.js (supabaseClient, escapeHtml, openModal, showToast, isVideoUrl, supaImageVariant,
// getMyRole, isPricingRole, projectNumberOnly, sydneyDateKey, dayKeyLabel) and email-compose.js (emailSize, emailPostFn).

const EMAIL_PHOTO_MIME = /^image\/(jpeg|jpg|png|webp|gif)$/i;

// Only received files (from Gmail) can be saved; files we sent already live in our storage.
const emailAttSavable = (att) => att && att.part_id !== undefined && att.part_id !== null && !att.storage;
// Saved to one of these jobs (emails.attachments[].saved_to, written by save-email-attachment).
const emailAttSaved = (att, jobIds) => ((att && att.saved_to) || []).some(s => jobIds.includes(s.project_id));
const emailSaveJobText = (att, jobs) => (emailAttSaved(att, (jobs || []).map(j => j.id)) ? '&#10003; On the job' : 'Save to job');

function emailSaveJobBtnsHtml(items, i) {
  const att = items[i] && items[i].att;
  if (!emailAttSavable(att)) return '';
  return `<button type="button" class="secondary email-save-job" data-sj="${i}" style="font-size:12px; padding:4px 10px;" title="Put this on the job's Site Photos or Documents">Save to job</button>`;
}

function emailSaveAllBtnHtml(items) {
  return items.filter(x => emailAttSavable(x.att)).length > 1
    ? '<button type="button" class="secondary email-save-all" style="font-size:12px; padding:4px 10px;">Save all to job</button>' : '';
}

// root: one wired box, or a page area holding several (the Inbox thread).
function emailSaveJobRefresh(root, jobs) {
  if (!root) return;
  const boxes = [root, ...root.querySelectorAll('.email-sj-root')].filter(b => b.emailSjItems);
  boxes.forEach(box => {
    box.querySelectorAll('.email-save-job, .email-save-all, .email-save-label').forEach(b => { b.style.display = (jobs || []).length ? (b.dataset.display || '') : 'none'; });
    box.querySelectorAll('.email-save-job').forEach(b => { b.innerHTML = emailSaveJobText(box.emailSjItems[Number(b.dataset.sj)].att, jobs); });
  });
}

function wireEmailSaveJob(root, items, opts) {
  root.classList.add('email-sj-root');
  root.emailSjItems = items;
  const after = (kind) => { emailSaveJobRefresh(root, opts.jobs()); if (opts.onSaved) opts.onSaved(kind); };
  root.querySelectorAll('.email-save-job').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSaveToJobPanel([items[Number(btn.dataset.sj)]], opts.jobs(), after);
    });
  });
  root.querySelectorAll('.email-save-all').forEach(btn => {
    btn.addEventListener('click', () => openSaveToJobPanel(items.filter(x => emailAttSavable(x.att)), opts.jobs(), after));
  });
  emailSaveJobRefresh(root, opts.jobs());
}

// One attachment: pick Site Photos (caption) or Documents (folder, file name). Several ("Save all"):
// pictures to Site Photos, the rest into one folder, each under its own file name.
async function openSaveToJobPanel(items, jobs, onSaved) {
  if (!jobs || !jobs.length) { alert('Tag this conversation to a job first.'); return; }
  const one = items.length === 1 ? items[0].att : null;
  const isPic = (a) => EMAIL_PHOTO_MIME.test(a.mime || '');
  const baseName = one ? String(one.name || 'file') : '';
  const overlay = openModal(`
    <h2 style="margin-top:0;">${one ? 'Save to job' : `Save ${items.length} attachments to the job`}</h2>
    <p class="subtitle" style="margin:0 0 8px; font-size:12px;">${one ? `${escapeHtml(baseName)}${one.size ? ' (' + emailSize(one.size) + ')' : ''}` : 'Pictures go on Site Photos, other files into Documents, each under its own file name.'}</p>
    <div id="sj-already" class="error-box" style="background:transparent; margin:0 0 8px; display:none;"></div>
    ${jobs.length > 1 ? `<label style="margin-top:0;">Job</label><select id="sj-job">${jobs.map(j => `<option value="${j.id}">${escapeHtml(j.label || '')}</option>`).join('')}</select>` : `<p style="margin:0 0 4px;"><strong>${escapeHtml(jobs[0].label || 'This job')}</strong></p>`}
    ${one ? `<label>Put it on</label>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400;"><input type="radio" name="sj-to" value="photos" ${isPic(one) ? 'checked' : 'disabled'} style="width:auto;" /> Site Photos${isPic(one) ? '' : ' (pictures only)'}</label>
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400;"><input type="radio" name="sj-to" value="documents" ${isPic(one) ? '' : 'checked'} style="width:auto;" /> Documents</label>
      </div>
      <label>Name it</label>
      <input id="sj-label" value="${escapeHtml(baseName.replace(/\.[^.]+$/, ''))}" />
      <p class="subtitle" style="margin:2px 0 0; font-size:12px;">The caption on Site Photos, or the file name in Documents (the file type is kept).</p>` : ''}
    <div id="sj-sq-wrap" style="display:none; margin-top:10px;">
      <label style="display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400;"><input type="checkbox" id="sj-sq" style="width:auto;" /> <span id="sj-sq-text">This is a supplier's quote for our price request</span></label>
      <select id="sj-sq-req" style="display:none; margin-top:6px;"></select>
    </div>
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
  // A supplier's quote for a price request on the job (item 81, pricing roles, one file): filed
  // under Supplier quotes with a supplier_quotes row, read by Tally.
  let sqRequests = [];
  const sqOn = () => !!(one && q('#sj-sq') && q('#sj-sq').checked && sqRequests.length);
  const loadRequests = async () => {
    sqRequests = [];
    const wrap = q('#sj-sq-wrap');
    if (!one || to() === 'photos') { wrap.style.display = 'none'; return; }
    const role = await getMyRole();
    if (!isPricingRole(role)) { wrap.style.display = 'none'; return; }
    const { data } = await supabaseClient.from('supplier_quote_requests').select('id, supplier_name, suppliers(name)').eq('project_id', jobId()).eq('status', 'sent').order('created_at');
    sqRequests = data || [];
    wrap.style.display = sqRequests.length ? '' : 'none';
    const sel = q('#sj-sq-req');
    sel.innerHTML = sqRequests.map(r => `<option value="${r.id}">From ${escapeHtml(r.suppliers?.name || r.supplier_name || 'the supplier')}</option>`).join('');
    sel.style.display = q('#sj-sq').checked && sqRequests.length > 1 ? '' : 'none';
  };
  const showFolder = () => { q('#sj-folder-wrap').style.display = to() === 'photos' || sqOn() ? 'none' : ''; };
  q('#sj-sq').addEventListener('change', () => { q('#sj-sq-req').style.display = q('#sj-sq').checked && sqRequests.length > 1 ? '' : 'none'; showFolder(); });
  const notYet = () => items.filter(x => !emailAttSaved(x.att, [jobId()]));
  const showAlready = () => {
    const already = items.length - notYet().length, box = q('#sj-already');
    box.style.display = already ? '' : 'none';
    box.textContent = one ? 'This is already on the job. Saving again makes a second copy.' : `${already} of these ${already === 1 ? 'is' : 'are'} already on the job and will be skipped.`;
  };
  folderSel.addEventListener('change', () => { q('#sj-new-folder').style.display = folderSel.value === '__new' ? '' : 'none'; });
  overlay.querySelectorAll('input[name="sj-to"]').forEach(r => r.addEventListener('change', () => { loadRequests(); showFolder(); }));
  if (q('#sj-job')) q('#sj-job').addEventListener('change', () => { loadFolders(); loadRequests(); showAlready(); });
  q('#sj-cancel').addEventListener('click', () => overlay.remove());
  showFolder();
  showAlready();
  loadFolders();
  loadRequests();

  q('#sj-save').addEventListener('click', async () => {
    const btn = q('#sj-save'), msg = q('#sj-msg');
    const folder = folderSel.value === '__new' ? q('#sj-new-folder').value.trim() : folderSel.value;
    const requestId = sqOn() ? (sqRequests.length > 1 ? q('#sj-sq-req').value : sqRequests[0].id) : undefined;
    if (to() !== 'photos' && !folder && !requestId) { msg.innerHTML = '<div class="error-box">Name the new folder.</div>'; return; }
    const todo = one ? items : notYet();
    if (!todo.length) { overlay.remove(); return; }
    btn.disabled = true;
    const kinds = new Set();
    let done = 0;
    try {
      for (const x of todo) {
        btn.textContent = todo.length > 1 ? `Saving ${done + 1} of ${todo.length}...` : 'Saving...';
        const dest = one ? to() : (isPic(x.att) ? 'photos' : 'documents');
        const r = await emailPostFn('save-email-attachment', { email_id: x.emailId, part_id: x.att.part_id, project_id: jobId(), to: dest, label: one ? q('#sj-label').value.trim() : '', folder, supplier_quote_request_id: requestId }, 'Could not save it');
        x.att.saved_to = [...(x.att.saved_to || []), { project_id: jobId(), kind: r.kind, id: r.id }];
        kinds.add(r.kind); done += 1;
      }
      overlay.remove();
      showToast(requestId ? 'Filed as the supplier\'s quote: Tally is reading it' : done === 1 ? (kinds.has('photo') ? 'Saved to Site Photos' : 'Saved to Documents') : `${done} saved to the job`);
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${done ? `${done} saved, then: ` : ''}${escapeHtml(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Save';
    } finally {
      kinds.forEach(k => onSaved && onSaved(k));
    }
  });
}

// ---------- Add from job ----------

// The job's documents and site photos as attachment refs, with sizes from storage where it says.
async function emailJobFiles(projectId) {
  const [{ data: job }, { data: docs }, { data: photos }] = await Promise.all([
    supabaseClient.from('projects').select('id, name, job_number, quote_number').eq('id', projectId).maybeSingle(),
    supabaseClient.from('project_documents').select('id, folder, file_path, file_name, created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabaseClient.from('project_photos').select('id, url, caption, created_at').eq('project_id', projectId).order('created_at', { ascending: false }),
  ]);
  const ref = projectNumberOnly(job) === '-' ? '' : projectNumberOnly(job);
  const marker = '/object/public/site-photos/';
  const pics = (photos || []).filter(p => p.url && p.url.includes(marker) && !isVideoUrl(p.url)).map(p => {
    const path = decodeURIComponent(p.url.split(marker)[1].split('?')[0]);
    const ext = (path.match(/\.([a-z0-9]{2,5})$/i) || [, 'jpg'])[1].toLowerCase();
    const day = dayKeyLabel(sydneyDateKey(new Date(p.created_at)));
    const title = String(p.caption || '').trim() || `Photo ${day}`;
    const name = `${ref ? ref + ' - ' : ''}${title}`.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) + '.' + ext;
    return { key: 'site-photos:' + path, bucket: 'site-photos', path, name, day, thumb: supaImageVariant(p.url, 240, 60), size: 0 };
  });
  const files = (docs || []).map(d => ({ key: 'project-documents:' + d.file_path, bucket: 'project-documents', path: d.file_path, name: d.file_name, folder: d.folder || 'General', size: 0 }));
  // sizes: list each folder the files sit in (best effort; the server checks the real total)
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const lists = [...new Set([...files, ...pics].map(f => f.bucket + '|' + dirOf(f.path)))].slice(0, 12);
  const sizes = {};
  await Promise.all(lists.map(async (k) => {
    const [bucket, dir] = k.split('|');
    try {
      const { data } = await supabaseClient.storage.from(bucket).list(dir, { limit: 1000 });
      (data || []).forEach(o => { if (o.metadata && o.metadata.size) sizes[`${bucket}:${dir}/${o.name}`] = o.metadata.size; });
    } catch (e) { /* no size shown */ }
  }));
  [...files, ...pics].forEach(f => { f.size = sizes[f.key] || 0; });
  return { files, pics };
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
  let renderId = 0;
  const render = async () => {
    const mine = ++renderId; // a job picked again before the last list came back: only the newest shows
    const body = q('#jf-body');
    body.innerHTML = '<p class="subtitle">Loading the job\'s documents and photos...</p>';
    let got;
    try { got = await emailJobFiles(q('#jf-job') ? q('#jf-job').value : jobs[0].id); } catch (err) { if (mine === renderId) body.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`; return; }
    if (mine !== renderId) return;
    current = got;
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
