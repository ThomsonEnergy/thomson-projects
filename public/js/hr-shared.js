// Shared HR workflow for admin/finance pages (staff.html, incident.html,
// incidents.html): written warnings and letters of counselling (create,
// sign and issue in the app, employee signs in person or in their own app,
// resolve, withdraw), private file storage, and quick incident creation.
// Needs supabase-client.js and hr-templates.js loaded first. Call
// await hrInit(session) once before using anything else.

const HR = { me: {}, company: null, myRole: 'staff', staff: [] };
const HR_BUCKET = 'staff-files';

async function hrInit(session) {
  const [role, { data: meRow }, { data: companyRow }, { data: staff }] = await Promise.all([
    getMyRole(),
    supabaseClient.from('profiles').select('id, full_name, job_title').eq('id', session.user.id).single(),
    supabaseClient.from('company_settings').select('company_name, abn, address, phone, logo_url').eq('id', 1).maybeSingle(),
    supabaseClient.from('profiles').select('id, full_name, job_title, mobile_number, active').order('full_name'),
  ]);
  HR.myRole = role;
  HR.me = meRow || { id: session.user.id };
  HR.company = companyRow && companyRow.company_name ? companyRow : Object.assign({}, HR_COMPANY_FALLBACK, companyRow || {}, { company_name: HR_COMPANY_FALLBACK.company_name });
  HR.staff = staff || [];
  return HR;
}
const hrIsFinance = () => HR.myRole === 'admin' || HR.myRole === 'finance';
const hrToday = () => hrLocalDate();
const hrStaffName = (id) => (HR.staff.find(s => s.id === id) || {}).full_name || '';

function hrModal(html, maxWidth = 640) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:flex-start; justify-content:center; z-index:150; padding:16px; overflow-y:auto;';
  overlay.innerHTML = `<div class="card" style="max-width:${maxWidth}px; width:100%; margin:20px 0;">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// ---------- Private files ----------

async function hrUpload(file, prefix) {
  file = await compressImage(file, DOC_IMAGE_MAX, DOC_IMAGE_QUALITY);
  const path = `${prefix}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await supabaseClient.storage.from(HR_BUCKET).upload(path, file);
  if (error) throw error;
  return path;
}
async function hrViewFile(path, title) {
  if (/\.pdf$/i.test(path)) { openPdfViewer(path, title || 'Document', { bucket: HR_BUCKET }); return; }
  if (/\.(jpe?g|png|webp|gif)$/i.test(path)) { const url = await getSignedDocUrl(path, HR_BUCKET); openPhotoLightbox([url], 0); return; }
  // First await in this branch: the tab opens on the tap itself, so iPhone does not block it as a popup.
  await openSignedDocInNewTab(path, HR_BUCKET);
}

// ---------- Warnings and letters ----------

// Suggested level: step up only when there's a live warning in the SAME
// category, and never suggest "final" - that's always a deliberate choice.
function hrSuggestLevel(category, existing) {
  const live = existing.filter(w => w.letter_type !== 'counselling' && w.category === category && warningIsLive(w));
  return { level: live.length ? 'second' : 'first', live };
}

async function hrSaveWarning(id, updates) {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabaseClient.from('staff_warnings').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// opts: { person: {id, full_name, job_title}, existing, prefill, onSaved(row) }
async function hrOpenLetterEditor(opts) {
  const { person, existing, prefill = {}, onSaved } = opts;
  const { data: history } = await supabaseClient.from('staff_warnings').select('*').eq('profile_id', person.id).order('issued_date', { ascending: false });
  const others = (history || []).filter(h => !existing || h.id !== existing.id);
  const base = existing || Object.assign({
    letter_type: 'warning', category: 'conduct', status: 'draft', active_months: 12,
    issued_date: hrToday(), meeting_date: hrToday(),
    issued_by_name: HR.me.full_name || '', issued_by_position: HR.me.job_title || '',
  }, prefill);
  if (!existing) base.warning_level = prefill.warning_level || hrSuggestLevel(base.category, others).level;
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  const prevText = (cat) => others.filter(w => w.category === cat && ['issued', 'acknowledged', 'resolved'].includes(w.status))
    .map(w => `${letterTitle(w)} ${hrDate(w.issued_date)}${w.subject ? ' (' + w.subject + ')' : ''}${warningIsLive(w) ? '' : w.status === 'resolved' ? ', since resolved' : ', since expired'}.`).join('\n');
  if (!existing && !base.previous_discussions) base.previous_discussions = prevText(base.category);

  const o = hrModal(`
    <h2>${existing ? 'Edit' : 'New'} letter - ${escapeHtml(person.full_name)}</h2>
    ${base.incident_id ? '<p class="subtitle">Linked to an incident report.</p>' : ''}
    <div class="grid cols-3">
      <div><label style="margin-top:0">Type</label><select id="w-type">${opt({ warning: 'Written warning', counselling: 'Letter of counselling (not disciplinary)' }, base.letter_type)}</select></div>
      <div><label style="margin-top:0">About</label><select id="w-category">${opt(WARNING_CATEGORY_LABELS, base.category)}</select></div>
      <div class="w-warning-only"><label style="margin-top:0">Level</label><select id="w-level">${opt(WARNING_LEVEL_LABELS, base.warning_level)}</select></div>
    </div>
    <div id="w-level-note" class="subtitle" style="margin-top:6px;"></div>
    <label>Subject (short)</label><input id="w-subject" value="${escapeHtml(base.subject || '')}" placeholder="e.g. Cut a cable without testing it was dead" />
    <div class="grid cols-3">
      <div><label>Date it happened</label><input type="date" id="w-incident-date" value="${base.incident_date || ''}" /></div>
      <div><label>Meeting date</label><input type="date" id="w-meeting-date" value="${base.meeting_date || ''}" /></div>
      <div><label>Letter date</label><input type="date" id="w-issued-date" value="${base.issued_date || ''}" /></div>
    </div>
    <label>What happened / the concern (facts only: dates, places, who saw it)</label>
    <textarea id="w-details" style="min-height:110px;">${escapeHtml(base.details || '')}</textarea>
    <label>Policy, procedure or standard expected</label>
    <textarea id="w-policy" placeholder="e.g. Test before you touch (AS/NZS 4836), Code of Conduct section 3">${escapeHtml(base.policy_breached || '')}</textarea>
    <div class="w-warning-only"><label>Previous discussions or warnings</label><textarea id="w-previous">${escapeHtml(base.previous_discussions || '')}</textarea></div>
    <label>Their response at the meeting</label>
    <textarea id="w-response">${escapeHtml(base.employee_response || '')}</textarea>
    <label>What has to change / the plan</label>
    <textarea id="w-improvement">${escapeHtml(base.expected_improvement || '')}</textarea>
    <label>Support the company will provide</label>
    <textarea id="w-support" placeholder="e.g. Refresher training on isolation and testing, supervised for 2 weeks, check-ins every Friday">${escapeHtml(base.support_offered || '')}</textarea>
    <label>Consequences / going forward (leave blank for the standard wording)</label>
    <textarea id="w-consequences">${escapeHtml(base.consequences || '')}</textarea>
    <div class="grid cols-3">
      <div><label>Review date</label><input type="date" id="w-review-date" value="${base.review_date || ''}" /></div>
      <div class="w-warning-only"><label>Active for</label><select id="w-active">${[6, 12, 18, 24].map(m => `<option value="${m}" ${Number(base.active_months || 12) === m ? 'selected' : ''}>${m} months</option>`).join('')}</select></div>
      <div><label>Support person / witness</label><input id="w-support-person" value="${escapeHtml(base.support_person || '')}" /></div>
    </div>
    <div class="grid cols-2">
      <div><label>Issued by</label><input id="w-by-name" value="${escapeHtml(base.issued_by_name || '')}" /></div>
      <div><label>Their position</label><input id="w-by-position" value="${escapeHtml(base.issued_by_position || '')}" /></div>
    </div>
    <div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" id="w-save">Save draft</button>
      <button type="button" class="secondary" id="w-preview">Preview letter</button>
      <button type="button" class="secondary" id="w-cancel">Cancel</button>
    </div>
    <div id="w-msg"></div>`, 760);

  const q = (s) => o.querySelector(s);
  const v = (s) => (q(s) ? q(s).value.trim() : '');
  const nn = (s) => v(s) || null;
  const refresh = () => {
    const counselling = v('#w-type') === 'counselling';
    o.querySelectorAll('.w-warning-only').forEach(el => { el.style.display = counselling ? 'none' : ''; });
    q('#w-consequences').placeholder = defaultWarningConsequences(v('#w-level'), v('#w-type'));
    const { level, live } = hrSuggestLevel(v('#w-category'), others);
    q('#w-level-note').innerHTML = counselling ? 'A letter of counselling records a conversation and a plan. It is not a warning and does not count towards escalation.'
      : live.length ? `Live ${escapeHtml(WARNING_CATEGORY_LABELS[v('#w-category')].toLowerCase())} warning on file: ${live.map(w => escapeHtml(letterTitle(w).toLowerCase()) + ' ' + hrDate(w.issued_date)).join(', ')}. Suggested level: ${level}.`
      : 'No live warning about this on file, so a first warning is suggested. Pick "final" only if it is serious enough on its own.';
  };
  refresh();
  q('#w-type').addEventListener('change', refresh);
  q('#w-level').addEventListener('change', refresh);
  q('#w-category').addEventListener('change', () => {
    if (!existing) { q('#w-level').value = hrSuggestLevel(v('#w-category'), others).level; q('#w-previous').value = prevText(v('#w-category')); }
    refresh();
  });
  q('#w-cancel').addEventListener('click', () => o.remove());

  const collect = () => {
    const counselling = v('#w-type') === 'counselling';
    return {
      profile_id: person.id, letter_type: v('#w-type'), category: v('#w-category'),
      warning_level: counselling ? 'first' : v('#w-level'), active_months: counselling ? 12 : Number(v('#w-active') || 12),
      subject: v('#w-subject'), details: v('#w-details'),
      incident_date: nn('#w-incident-date'), meeting_date: nn('#w-meeting-date'), issued_date: v('#w-issued-date') || hrToday(),
      policy_breached: nn('#w-policy'), previous_discussions: counselling ? null : nn('#w-previous'), employee_response: nn('#w-response'),
      expected_improvement: nn('#w-improvement'), support_offered: nn('#w-support'), consequences: nn('#w-consequences'),
      review_date: nn('#w-review-date'), support_person: nn('#w-support-person'),
      issued_by_name: nn('#w-by-name'), issued_by_position: nn('#w-by-position'),
      incident_id: base.incident_id || null,
    };
  };
  q('#w-preview').addEventListener('click', () => showHrDocument(writtenWarningHtml(Object.assign({ id: 'preview' }, collect()), person, HR.company), 'Preview'));
  q('#w-save').addEventListener('click', async () => {
    const btn = q('#w-save'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const payload = collect();
      if (!payload.subject && !payload.details) { q('#w-msg').innerHTML = '<div class="error-box">Add a subject or describe the concern.</div>'; return; }
      payload.updated_at = new Date().toISOString();
      let res;
      if (existing) {
        // Editing after it was signed changes what was signed, so it goes back to a draft.
        Object.assign(payload, { status: 'draft', manager_signature_data_url: null, manager_signed_at: null, employee_signature_data_url: null, employee_signed_at: null,
          employee_signed_name: null, employee_signed_how: null, witness_signature_data_url: null, witness_signed_at: null, sent_to_employee_at: null, refused_to_sign: false, acknowledged_at: null });
        res = await supabaseClient.from('staff_warnings').update(payload).eq('id', existing.id).select().single();
      } else {
        payload.issued_by = HR.me.id; payload.status = 'draft';
        res = await supabaseClient.from('staff_warnings').insert(payload).select().single();
      }
      if (res.error) { q('#w-msg').innerHTML = `<div class="error-box">${escapeHtml(res.error.message)}</div>`; return; }
      o.remove();
      if (onSaved) onSaved(res.data);
    } finally { btn.disabled = false; btn.textContent = label; }
  });
}

// Manager signs: the letter becomes "issued".
function hrSignAndIssue(w, person, onDone) {
  const o = hrModal(`
    <h2>Sign and issue - ${escapeHtml(letterTitle(w))}</h2>
    <p class="subtitle">To ${escapeHtml(person.full_name)}. Read it through first: once it's signed, changing it puts it back to a draft and clears the signatures.</p>
    <button type="button" class="secondary" id="si-preview" style="font-size:12px; padding:6px 10px;">Read the letter</button>
    <div class="grid cols-2">
      <div><label>Your name</label><input id="si-name" value="${escapeHtml(w.issued_by_name || HR.me.full_name || '')}" /></div>
      <div><label>Position</label><input id="si-position" value="${escapeHtml(w.issued_by_position || HR.me.job_title || '')}" /></div>
    </div>
    <label>Your signature</label><div id="si-pad"></div>
    <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;"><button type="button" id="si-save">Sign and issue</button><button type="button" class="secondary" id="si-cancel">Cancel</button></div>
    <div id="si-msg"></div>`, 560);
  const pad = createSignaturePad(o.querySelector('#si-pad'));
  o.querySelector('#si-preview').addEventListener('click', () => showHrDocument(writtenWarningHtml(w, person, HR.company), letterTitle(w)));
  o.querySelector('#si-cancel').addEventListener('click', () => o.remove());
  o.querySelector('#si-save').addEventListener('click', async () => {
    if (pad.isEmpty()) { o.querySelector('#si-msg').innerHTML = '<div class="error-box">Draw your signature.</div>'; return; }
    const btn = o.querySelector('#si-save'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Signing...';
    try {
      const row = await hrSaveWarning(w.id, {
        status: 'issued', manager_signature_data_url: pad.toDataURL(), manager_signed_at: new Date().toISOString(),
        issued_by_name: o.querySelector('#si-name').value.trim() || null, issued_by_position: o.querySelector('#si-position').value.trim() || null,
      });
      o.remove(); onDone(row);
    } catch (err) { o.querySelector('#si-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; }
    finally { btn.disabled = false; btn.textContent = label; }
  });
}

// The employee signs on this device, in the meeting. Or declines, with a witness signing instead.
function hrEmployeeSignsNow(w, person, onDone) {
  const o = hrModal(`
    <h2>${escapeHtml(person.full_name)} signs now</h2>
    <p class="subtitle">Hand the device over. They can read the letter, add comments, and sign. Signing confirms they received it, not that they agree.</p>
    <button type="button" class="secondary" id="es-preview" style="font-size:12px; padding:6px 10px;">Read the letter</button>
    <label style="display:flex; align-items:center; gap:8px; margin-top:12px;"><input type="checkbox" id="es-refused" style="width:auto;" /> They have declined to sign (a witness signs instead)</label>
    <div id="es-employee">
      <label>Their name</label><input id="es-name" value="${escapeHtml(person.full_name || '')}" />
      <label>Their comments (optional)</label><textarea id="es-comments">${escapeHtml(w.employee_comments || '')}</textarea>
      <label>Their signature</label><div id="es-pad"></div>
    </div>
    <label>Witness / support person (optional${w.support_person ? '' : ', required if they decline'})</label>
    <input id="es-witness-name" value="${escapeHtml(w.support_person || '')}" placeholder="Name" />
    <div id="es-witness-pad" style="margin-top:6px;"></div>
    <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;"><button type="button" id="es-save">Save</button><button type="button" class="secondary" id="es-cancel">Cancel</button></div>
    <div id="es-msg"></div>`, 560);
  const pad = createSignaturePad(o.querySelector('#es-pad'));
  const wpad = createSignaturePad(o.querySelector('#es-witness-pad'), 110);
  const refused = o.querySelector('#es-refused');
  refused.addEventListener('change', () => { o.querySelector('#es-employee').style.display = refused.checked ? 'none' : ''; });
  o.querySelector('#es-preview').addEventListener('click', () => showHrDocument(writtenWarningHtml(w, person, HR.company), letterTitle(w)));
  o.querySelector('#es-cancel').addEventListener('click', () => o.remove());
  o.querySelector('#es-save').addEventListener('click', async () => {
    const btn = o.querySelector('#es-save'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const msg = o.querySelector('#es-msg');
      const witnessName = o.querySelector('#es-witness-name').value.trim();
      const updates = { support_person: witnessName || w.support_person || null };
      if (!wpad.isEmpty()) Object.assign(updates, { witness_signature_data_url: wpad.toDataURL(), witness_signed_at: new Date().toISOString() });
      if (refused.checked) {
        if (wpad.isEmpty() || !witnessName) { msg.innerHTML = '<div class="error-box">When they decline, a witness needs to add their name and sign.</div>'; return; }
        Object.assign(updates, { refused_to_sign: true });
      } else {
        if (pad.isEmpty()) { msg.innerHTML = '<div class="error-box">They need to sign, or tick that they declined.</div>'; return; }
        Object.assign(updates, {
          refused_to_sign: false, employee_signature_data_url: pad.toDataURL(), employee_signed_at: new Date().toISOString(),
          employee_signed_name: o.querySelector('#es-name').value.trim() || person.full_name, employee_signed_how: 'in_person',
          employee_comments: o.querySelector('#es-comments').value.trim() || null, acknowledged_at: hrToday(), status: 'acknowledged',
        });
      }
      try { const row = await hrSaveWarning(w.id, updates); o.remove(); onDone(row); }
      catch (err) { msg.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; }
    } finally { btn.disabled = false; btn.textContent = label; }
  });
}

async function hrSendToEmployee(w, onDone) {
  const { error } = await supabaseClient.rpc('send_hr_letter', { p_id: w.id });
  if (error) { alert(error.message); return; }
  const { data } = await supabaseClient.from('staff_warnings').select('*').eq('id', w.id).single();
  onDone(data);
}

function hrResolve(w, person, onDone) {
  const o = hrModal(`
    <h2>Mark as resolved</h2>
    <p class="subtitle">${escapeHtml(letterTitle(w))} to ${escapeHtml(person.full_name)}, ${hrDate(w.issued_date)}. It stays on file as a record but no longer counts towards stepping up.</p>
    <div class="grid cols-2">
      <div><label>Resolved on</label><input type="date" id="rs-date" value="${hrToday()}" /></div>
      <div><label>By</label><input id="rs-by" value="${escapeHtml(HR.me.full_name || '')}" /></div>
    </div>
    <label>Note (goes in the resolution letter)</label>
    <textarea id="rs-note" placeholder="e.g. Since our meeting you have completed the refresher training and your testing has been checked on every job. Great work."></textarea>
    <label style="display:flex; align-items:center; gap:8px; margin-top:10px;"><input type="checkbox" id="rs-notify" style="width:auto;" checked /> Let them know in the app (they'll see the resolution letter)</label>
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="rs-save">Mark resolved</button><button type="button" class="secondary" id="rs-cancel">Cancel</button></div>
    <div id="rs-msg"></div>`, 560);
  o.querySelector('#rs-cancel').addEventListener('click', () => o.remove());
  o.querySelector('#rs-save').addEventListener('click', async () => {
    const btn = o.querySelector('#rs-save'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      let row = await hrSaveWarning(w.id, {
        status: 'resolved', resolved_at: o.querySelector('#rs-date').value || hrToday(),
        resolved_note: o.querySelector('#rs-note').value.trim() || null, resolved_by_name: o.querySelector('#rs-by').value.trim() || null,
      });
      if (o.querySelector('#rs-notify').checked) {
        const { error } = await supabaseClient.rpc('send_hr_letter', { p_id: w.id });
        if (error) throw error;
        row = (await supabaseClient.from('staff_warnings').select('*').eq('id', w.id).single()).data || row;
      }
      o.remove(); onDone(row);
    } catch (err) { o.querySelector('#rs-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; }
    finally { btn.disabled = false; btn.textContent = label; }
  });
}

// Renders letters as a list with every action they need. personFor(w)
// returns {id, full_name, job_title}; onChange() re-renders the page.
function hrRenderLetterList(container, letters, personFor, onChange, opts = {}) {
  if (!letters.length) { container.innerHTML = `<p class="subtitle">${opts.emptyText || 'No letters on file.'}</p>`; return; }
  const badgeClass = (w) => {
    const s = warningDisplayStatus(w);
    return s === 'Draft' || s === 'Withdrawn' || s === 'Expired' ? 'draft' : s === 'Issued' ? 'amber' : 'accepted';
  };
  container.innerHTML = letters.map(w => {
    const p = personFor(w);
    const signedLine = w.employee_signed_at ? `signed ${hrDate(w.employee_signed_at)}${w.employee_signed_how === 'in_app' ? ' in their app' : ''}`
      : w.refused_to_sign ? 'declined to sign (witnessed)'
      : w.sent_to_employee_at ? `sent to their app ${hrDate(w.sent_to_employee_at)}, not signed yet` : '';
    const live = warningIsLive(w) && w.letter_type !== 'counselling';
    return `
    <div class="project-list-item" data-id="${w.id}">
      <div>
        <div class="name">${opts.showPerson ? escapeHtml(p.full_name) + ': ' : ''}${escapeHtml(letterTitle(w))}${w.subject ? ' - ' + escapeHtml(w.subject) : ''}</div>
        <div class="meta">${escapeHtml(WARNING_CATEGORY_LABELS[w.category] || '')} &middot; ${hrDate(w.issued_date)}
          &middot; <span class="badge ${badgeClass(w)}">${escapeHtml(warningDisplayStatus(w))}</span>
          ${live ? ` &middot; active until ${hrDate(warningExpiry(w))}` : ''}
          ${signedLine ? ' &middot; ' + signedLine : ''}
          ${w.employee_comments ? ' &middot; <em>has comments</em>' : ''}
          ${w.incident_id && !opts.hideIncidentLink ? ` &middot; <a class="link-quiet" href="/incident.html?id=${w.incident_id}">incident</a>` : ''}</div>
      </div>
      <div class="row-actions" style="white-space:nowrap; text-align:right;">
        <button type="button" class="secondary l-act" data-act="view">View</button>
        ${w.status === 'draft' ? `<button type="button" class="secondary l-act" data-act="edit">Edit</button><button type="button" class="l-act" data-act="issue">Sign &amp; issue</button>` : ''}
        ${['issued'].includes(w.status) && !w.employee_signed_at ? `<button type="button" class="l-act" data-act="signnow">Employee signs now</button><button type="button" class="secondary l-act" data-act="send">${w.sent_to_employee_at ? 'Resend to app' : 'Send to their app'}</button>` : ''}
        ${['issued', 'acknowledged'].includes(w.status) ? `<button type="button" class="secondary l-act" data-act="resolve">Resolve</button>` : ''}
        ${w.status === 'resolved' ? `<button type="button" class="secondary l-act" data-act="resletter">Resolution letter</button>` : ''}
        <button type="button" class="secondary l-act" data-act="more">&hellip;</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.l-act').forEach(b => b.addEventListener('click', async () => {
    const w = letters.find(x => x.id === b.closest('[data-id]').dataset.id);
    const p = personFor(w);
    const done = () => onChange();
    switch (b.dataset.act) {
      case 'view': {
        const ov = showHrDocument(writtenWarningHtml(w, p, HR.company), `${letterTitle(w)} - ${p.full_name}`,
          w.signed_file_path ? '<button type="button" class="secondary hr-paper">Paper copy</button>' : '');
        const paper = ov.querySelector('.hr-paper');
        if (paper) paper.addEventListener('click', () => hrViewFile(w.signed_file_path, 'Signed paper copy').catch(e => alert(e.message)));
        break;
      }
      case 'edit': hrOpenLetterEditor({ person: p, existing: w, onSaved: done }); break;
      case 'issue': hrSignAndIssue(w, p, done); break;
      case 'signnow': hrEmployeeSignsNow(w, p, done); break;
      case 'send':
        if (confirm(`Send this letter to ${p.full_name}'s app? They get a notification and can read, comment and sign it there.`)) await hrSendToEmployee(w, done);
        break;
      case 'resolve': hrResolve(w, p, done); break;
      case 'resletter': showHrDocument(resolutionLetterHtml(w, p, HR.company), 'Resolution letter'); break;
      case 'more': hrLetterMoreMenu(w, p, done); break;
    }
  }));
}

function hrLetterMoreMenu(w, p, done) {
  const o = hrModal(`
    <h2>${escapeHtml(letterTitle(w))}</h2>
    <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-start;">
      ${w.status !== 'draft' ? '<button type="button" class="secondary" data-m="edit">Edit (puts it back to a draft and clears signatures)</button>' : ''}
      <button type="button" class="secondary" data-m="upload">${w.signed_file_path ? 'Replace' : 'Upload'} a signed paper copy</button>
      ${['issued', 'acknowledged'].includes(w.status) ? '<button type="button" class="secondary" data-m="withdraw">Withdraw it (keeps the record, no longer counts)</button>' : ''}
      <button type="button" class="secondary" data-m="delete">Delete permanently</button>
      <button type="button" class="secondary" data-m="close">Close</button>
    </div>`, 460);
  o.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', async () => {
    const m = b.dataset.m;
    o.remove();
    if (m === 'edit') hrOpenLetterEditor({ person: p, existing: w, onSaved: done });
    if (m === 'withdraw' && confirm('Withdraw this letter? It stays on file marked withdrawn.')) { await hrSaveWarning(w.id, { status: 'withdrawn' }).catch(e => alert(e.message)); done(); }
    if (m === 'delete' && confirm('Delete this letter permanently? Withdrawing it is usually better so there is still a record. Delete anyway?')) {
      const { error } = await supabaseClient.from('staff_warnings').delete().eq('id', w.id);
      if (error) { alert(error.message); return; }
      if (w.signed_file_path) await supabaseClient.storage.from(HR_BUCKET).remove([w.signed_file_path]);
      done();
    }
    if (m === 'upload') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.pdf,.jpg,.jpeg,.png,.webp';
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file) return;
        try {
          const path = await hrUpload(file, `${w.profile_id}/warnings`);
          await hrSaveWarning(w.id, { signed_file_path: path, signed_file_name: file.name, ...(w.status === 'issued' ? { status: 'acknowledged', acknowledged_at: w.acknowledged_at || hrToday() } : {}) });
          done();
        } catch (err) { alert(err.message); }
      });
      input.click();
    }
  }));
}

// ---------- Quick incident creation ----------

// Creates the incident and the people in it, then opens the incident page.
// opts: { preselect: [profileId] }
function hrNewIncident(opts = {}) {
  const pre = new Set(opts.preselect || []);
  const now = new Date();
  const roleSelect = (id) => `<select class="ni-role" data-id="${id}" style="max-width:170px; margin:0; padding:4px 6px; font-size:12px;">${Object.entries(INCIDENT_ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${k === 'involved' ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const o = hrModal(`
    <h2>New incident, near miss or accident</h2>
    <p class="subtitle">Get the basics down now. Add statements, photos, findings, actions and reporting on the incident page next.</p>
    <div class="grid cols-3">
      <div><label style="margin-top:0">Type</label><select id="ni-nature">${Object.entries(INCIDENT_NATURE_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div><label style="margin-top:0">Date</label><input type="date" id="ni-date" value="${hrToday()}" /></div>
      <div><label style="margin-top:0">Time</label><input type="time" id="ni-time" value="${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}" /></div>
    </div>
    <label>What happened, in one line</label>
    <input id="ni-title" placeholder="e.g. Live cable cut during disconnection, pliers destroyed, no injury" />
    <label>Job (optional)</label>
    <input id="ni-job" placeholder="Search job number, client or address" autocomplete="off" />
    <div id="ni-job-results"></div>
    <label>Exact location</label><input id="ni-location" />
    <label>Staff involved</label>
    <div id="ni-people" style="max-height:260px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:6px 10px;">
      ${HR.staff.filter(s => s.active).map(s => `
        <div style="display:flex; align-items:center; gap:8px; padding:3px 0;">
          <label style="display:flex; align-items:center; gap:8px; margin:0; flex:1; color:var(--text);"><input type="checkbox" class="ni-person" value="${s.id}" style="width:auto;" ${pre.has(s.id) ? 'checked' : ''} /> ${escapeHtml(s.full_name)}</label>
          ${roleSelect(s.id)}
        </div>`).join('')}
    </div>
    <p class="subtitle" style="margin-top:6px;">Visitors, subbies and witnesses who aren't staff can be added on the incident page.</p>
    <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="ni-save">Create</button><button type="button" class="secondary" id="ni-cancel">Cancel</button></div>
    <div id="ni-msg"></div>`, 620);
  let projectId = null, timer = null;
  const job = o.querySelector('#ni-job');
  job.addEventListener('input', () => {
    clearTimeout(timer); projectId = null;
    timer = setTimeout(async () => {
      const results = await searchProjects(job.value, 8);
      const box = o.querySelector('#ni-job-results');
      box.innerHTML = results.map(p => `<div class="project-list-item ni-pick" data-id="${p.id}" data-addr="${escapeHtml(p.client_address || '')}" data-label="${escapeHtml((p.job_number ? 'J' + p.job_number + ' - ' : '') + p.name)}" style="cursor:pointer; padding:6px 4px;">
        <div><div class="name" style="font-size:13px;">${p.job_number ? 'J' + p.job_number + ' - ' : ''}${escapeHtml(p.name)}</div><div class="meta">${escapeHtml(p.client_address || p.client_name || '')}</div></div></div>`).join('');
      box.querySelectorAll('.ni-pick').forEach(d => d.addEventListener('click', () => {
        projectId = d.dataset.id; job.value = d.dataset.label;
        if (!o.querySelector('#ni-location').value) o.querySelector('#ni-location').value = d.dataset.addr;
        box.innerHTML = '';
      }));
    }, 250);
  });
  o.querySelector('#ni-cancel').addEventListener('click', () => o.remove());
  o.querySelector('#ni-save').addEventListener('click', async () => {
    const msg = o.querySelector('#ni-msg');
    const title = o.querySelector('#ni-title').value.trim();
    if (!title) { msg.innerHTML = '<div class="error-box">Say in one line what happened.</div>'; return; }
    const btn = o.querySelector('#ni-save'); const label = btn.textContent;
    let navigated = false;
    btn.disabled = true; btn.textContent = 'Creating...';
    try {
      const chosen = [...o.querySelectorAll('.ni-person:checked')].map(c => ({ id: c.value, role: o.querySelector(`.ni-role[data-id="${c.value}"]`).value }));
      const injured = chosen.find(c => c.role === 'injured');
      const injuredStaff = injured ? HR.staff.find(s => s.id === injured.id) : null;
      let injuredSensitive = null;
      if (injured) injuredSensitive = (await supabaseClient.from('profiles_sensitive_secure').select('*').eq('id', injured.id).maybeSingle()).data;
      const { data: inc, error } = await supabaseClient.from('incident_reports').insert({
        nature: o.querySelector('#ni-nature').value, incident_date: o.querySelector('#ni-date').value || hrToday(),
        incident_time: o.querySelector('#ni-time').value || null, title, project_id: projectId,
        site_location: o.querySelector('#ni-location').value.trim() || null,
        injured_profile_id: injured ? injured.id : null,
        injured_name: injuredStaff ? injuredStaff.full_name : null, injured_occupation: injuredStaff ? injuredStaff.job_title : null,
        injured_phone: injuredStaff ? injuredStaff.mobile_number : null, injured_dob: injuredSensitive ? injuredSensitive.date_of_birth : null,
        injured_address: injuredSensitive ? [injuredSensitive.residential_address, injuredSensitive.residential_suburb, injuredSensitive.residential_state, injuredSensitive.residential_postcode].filter(Boolean).join(', ') || null : null,
        injured_employer: injured ? HR.company.company_name : null,
        completed_by_name: HR.me.full_name || null, completed_by_position: HR.me.job_title || null, completed_date: hrToday(),
        created_by: HR.me.id, status: 'open',
      }).select().single();
      if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
      if (chosen.length) {
        const { error: pErr } = await supabaseClient.from('incident_people').insert(chosen.map(c => {
          const s = HR.staff.find(x => x.id === c.id) || {};
          return { incident_id: inc.id, profile_id: c.id, name: s.full_name || 'Staff member', contact: s.mobile_number || null, role: c.role };
        }));
        if (pErr) { msg.innerHTML = `<div class="error-box">Incident saved, but adding people failed: ${escapeHtml(pErr.message)}</div>`; return; }
      }
      navigated = true;
      window.location.href = `/incident.html?id=${inc.id}`;
    } finally { if (!navigated) { btn.disabled = false; btn.textContent = label; } }
  });
}
