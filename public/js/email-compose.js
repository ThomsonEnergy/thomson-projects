// Sending email from the shared sales@ inbox - used by the Inbox page and by the job page.
//   emailLocalFilePicker(el)   an "Attach files" button + chips; returns { files(), clear() }
//   emailSendNow(payload)      uploads nothing itself: posts to send-gmail and returns { threadId }
//   openEmailComposer(opts)    the compose / reply window, with job documents to attach
//   openTagEmailModal(opts)    tag a conversation to a job (or pick a conversation for a job)
//   EMAIL_KINDS                why an email is tagged to a job
// Needs supabase-client.js (supabaseClient, escapeHtml, projectRef, searchProjects).

const EMAIL_MAX_FILE = 15 * 1024 * 1024;
const EMAIL_MAX_TOTAL = 20 * 1024 * 1024;
const EMAIL_MAX_FILES = 10;
const EMAIL_KINDS = { materials_quote: 'Materials quote', client: 'Client', supplier: 'Supplier', other: 'Other' };

const emailSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// A file we attached to an email we sent: it lives in our own storage.
async function fetchStoredAttachment(att) {
  const { data, error } = await supabaseClient.storage.from(att.storage.bucket).download(att.storage.path);
  if (error || !data) throw new Error('Could not open that file: ' + (error ? error.message : 'not found'));
  const buf = new Uint8Array(await data.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { name: att.name, mime: att.mime || data.type || 'application/octet-stream', data: btoa(bin) };
}

// One attachment (or inline picture) of a received email, fetched from Gmail when asked for.
async function fetchEmailAttachment(emailId, partId) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/get-email-attachment', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ email_id: emailId, part_id: partId }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error('Could not get that file (status ' + res.status + '). Try again.'); }
  if (!data.ok) throw new Error(data.error || 'Could not get that file.');
  return data;
}

// "Bob Jones <bob@x.com>" -> "bob@x.com"
function emailAddressOnly(raw) {
  const m = String(raw || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(raw || '')).trim();
}

function emailLocalFilePicker(el) {
  let files = [];
  el.innerHTML = `<input type="file" multiple style="display:none;" /><button type="button" class="secondary" style="font-size:12px; padding:6px 12px;">&#128206; Attach files</button><div class="eml-chips" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;"></div><div class="eml-pick-msg" style="font-size:12px; margin-top:4px;"></div>`;
  const input = el.querySelector('input'), chips = el.querySelector('.eml-chips'), msg = el.querySelector('.eml-pick-msg');
  const render = () => {
    chips.innerHTML = files.map((f, i) => `<span class="mt-chip" style="font-size:12px; padding:3px 10px; border:1px solid var(--border); border-radius:20px;">${escapeHtml(f.name)} (${emailSize(f.size)}) <a href="#" data-rm="${i}" style="margin-left:4px;" title="Remove">&times;</a></span>`).join('');
    chips.querySelectorAll('[data-rm]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); files.splice(Number(a.dataset.rm), 1); render(); }));
  };
  el.querySelector('button').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    msg.textContent = '';
    for (const f of input.files) {
      if (f.size > EMAIL_MAX_FILE) { msg.innerHTML = `<span style="color:var(--red);">"${escapeHtml(f.name)}" is over 15 MB, so it was not added.</span>`; continue; }
      files.push(f);
    }
    input.value = '';
    render();
  });
  return { files: () => files, clear: () => { files = []; render(); } };
}

// Uploads local files to the private email-attachments bucket.
async function emailUploadFiles(files) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const out = [];
  for (const f of files) {
    const safe = f.name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 100);
    const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const { error } = await supabaseClient.storage.from('email-attachments').upload(path, f, { contentType: f.type || undefined });
    if (error) throw new Error(`Could not upload "${f.name}": ${error.message}`);
    out.push({ bucket: 'email-attachments', path, name: f.name, size: f.size });
  }
  return out;
}

async function emailSendNow(payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/send-gmail', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error(`The email did not go (status ${res.status}). Try again.`); }
  if (!data.ok) throw new Error(data.error || 'The email did not go.');
  return data;
}

// opts: { title, to, cc, subject, body, replyToThreadId, projectId, tagKind, quoteLink: {url, label},
//         attachOptions: [{ group, label, bucket, path, name, size, checked }], onSent(threadId) }
function openEmailComposer(opts) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:120; padding:16px;';
  const options = opts.attachOptions || [];
  const groups = [...new Set(options.map(o => o.group || 'Files'))];
  overlay.innerHTML = `
    <div class="card" style="max-width:640px; width:100%; max-height:92vh; overflow-y:auto;">
      <h2 style="margin-top:0;">${escapeHtml(opts.title || 'New email')}</h2>
      <p class="subtitle" style="margin:0 0 8px; font-size:12px;">Sent from sales@thomsonenergy.com.au with your name and signature.</p>
      <label style="margin-top:0">To</label>
      <input id="ec-to" value="${escapeHtml(opts.to || '')}" placeholder="client@example.com (separate several with commas)" />
      <label>Cc (optional)</label>
      <input id="ec-cc" value="${escapeHtml(opts.cc || '')}" />
      <label>Subject</label>
      <input id="ec-subject" value="${escapeHtml(opts.subject || '')}" />
      <label>Message</label>
      <textarea id="ec-body" style="min-height:170px;">${escapeHtml(opts.body || '')}</textarea>
      ${opts.quoteLink ? `<label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:10px;"><input type="checkbox" id="ec-quote-link" style="width:auto;" /> ${escapeHtml(opts.quoteLink.label || 'Include a link to view and accept the quote online')}</label>` : ''}
      <label>Attachments</label>
      ${options.length ? groups.map(g => `
        <div style="margin-bottom:8px;">
          <div class="subtitle" style="font-size:12px; margin-bottom:2px;">${escapeHtml(g)}</div>
          ${options.map((o, i) => (o.group || 'Files') === g ? `<label style="display:flex; align-items:center; gap:8px; margin:0 0 3px; font-weight:400;"><input type="checkbox" class="ec-opt" data-i="${i}" ${o.checked ? 'checked' : ''} style="width:auto;" /> <span>${escapeHtml(o.label || o.name)}${o.size ? ` <span style="color:var(--muted);">(${emailSize(o.size)})</span>` : ''}</span></label>` : '').join('')}
        </div>`).join('') : ''}
      <div id="ec-picker"></div>
      <div style="margin-top:16px; display:flex; gap:8px;">
        <button type="button" id="ec-send">Send</button>
        <button type="button" class="secondary" id="ec-cancel">Cancel</button>
      </div>
      <div id="ec-msg" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  const picker = emailLocalFilePicker(overlay.querySelector('#ec-picker'));
  overlay.querySelector('#ec-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ec-send').addEventListener('click', async () => {
    const msg = overlay.querySelector('#ec-msg'), btn = overlay.querySelector('#ec-send');
    const to = overlay.querySelector('#ec-to').value.trim(), subject = overlay.querySelector('#ec-subject').value.trim();
    let bodyText = overlay.querySelector('#ec-body').value.trim();
    if (!to || !subject || !bodyText) { msg.innerHTML = '<div class="error-box">Fill in who it is to, the subject and a message.</div>'; return; }
    const chosen = [...overlay.querySelectorAll('.ec-opt:checked')].map(c => options[Number(c.dataset.i)]);
    const totalGuess = chosen.reduce((n, o) => n + (o.size || 0), 0) + picker.files().reduce((n, f) => n + f.size, 0);
    if (chosen.length + picker.files().length > EMAIL_MAX_FILES) { msg.innerHTML = `<div class="error-box">Attach up to ${EMAIL_MAX_FILES} files.</div>`; return; }
    if (totalGuess > EMAIL_MAX_TOTAL) { msg.innerHTML = '<div class="error-box">The attachments add up to more than 20 MB. Send them in more than one email.</div>'; return; }
    const ql = overlay.querySelector('#ec-quote-link');
    if (ql && ql.checked && opts.quoteLink) bodyText += `\n\n${opts.quoteLink.url}`;
    btn.disabled = true; btn.textContent = picker.files().length ? 'Uploading...' : 'Sending...';
    try {
      const uploaded = await emailUploadFiles(picker.files());
      btn.textContent = 'Sending...';
      const data = await emailSendNow({
        to, cc: overlay.querySelector('#ec-cc').value.trim() || undefined, subject, bodyText,
        replyToThreadId: opts.replyToThreadId || undefined,
        attachments: [...chosen.map(o => ({ bucket: o.bucket, path: o.path, name: o.name })), ...uploaded.map(u => ({ bucket: u.bucket, path: u.path, name: u.name }))],
        tagProjectId: opts.projectId || undefined, tagKind: opts.tagKind || 'client',
      });
      overlay.remove();
      if (opts.onSent) await opts.onSent(data.threadId);
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Send';
    }
  });
  setTimeout(() => overlay.querySelector(opts.to ? '#ec-body' : '#ec-to').focus(), 30);
}

// Tag a conversation to a job. Give threadId (pick the job) or projectId (pick the conversation).
function openTagEmailModal({ threadId, projectId, onSaved }) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:120; padding:16px;';
  const pickingJob = !!threadId;
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; width:100%; max-height:90vh; overflow-y:auto;">
      <h2 style="margin-top:0;">${pickingJob ? 'Tag this email to a job' : 'Tag an email to this job'}</h2>
      <label style="margin-top:0;">${pickingJob ? 'Which job?' : 'Which conversation?'}</label>
      <input id="tg-search" placeholder="${pickingJob ? 'Search job number, name, client...' : 'Search subjects (or leave blank for the latest)...'}" autocomplete="off" />
      <div id="tg-results"></div>
      <p class="subtitle" id="tg-picked" style="margin:6px 0 0;"></p>
      <label>What is it?</label>
      <select id="tg-kind">${Object.entries(EMAIL_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <p class="subtitle" style="margin:4px 0 0; font-size:12px;">e.g. "Materials quote" for a supplier quote we will order from once the job's quote is approved.</p>
      <label>Note (optional)</label>
      <input id="tg-note" placeholder="e.g. Order the group metering once approved" />
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="tg-save" disabled>Tag it</button><button type="button" class="secondary" id="tg-cancel">Cancel</button></div>
      <div id="tg-msg" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  let pickedProject = projectId || null, pickedThread = threadId || null, timer;
  const results = overlay.querySelector('#tg-results'), picked = overlay.querySelector('#tg-picked'), save = overlay.querySelector('#tg-save');
  const choose = (label) => { picked.textContent = 'Selected: ' + label; results.innerHTML = ''; save.disabled = false; };
  const row = (id, html, label) => `<div class="tg-row" data-id="${id}" data-label="${escapeHtml(label)}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${html}</div>`;
  async function search(q) {
    if (pickingJob) {
      if (q.length < 2) { results.innerHTML = ''; return; }
      const found = await searchProjects(q);
      results.innerHTML = found.length ? `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">${found.map(p => row(p.id, `${escapeHtml(projectRef(p))} <span class="subtitle">${escapeHtml(p.client_name || '')}</span>`, projectRef(p))).join('')}</div>` : '<p class="subtitle">No matches.</p>';
      results.querySelectorAll('.tg-row').forEach(r => r.addEventListener('click', () => { pickedProject = r.dataset.id; choose(r.dataset.label); }));
    } else {
      let qb = supabaseClient.from('email_threads').select('id, subject, last_message_at').order('last_message_at', { ascending: false }).limit(12);
      if (q.length >= 2) qb = qb.ilike('subject', `%${q.replace(/[%,()]/g, ' ')}%`);
      const { data } = await qb;
      results.innerHTML = (data || []).length ? `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">${data.map(t => row(t.id, `${escapeHtml(t.subject || '(no subject)')} <span class="subtitle">${new Date(t.last_message_at).toLocaleDateString('en-AU')}</span>`, t.subject || '(no subject)')).join('')}</div>` : '<p class="subtitle">No matches.</p>';
      results.querySelectorAll('.tg-row').forEach(r => r.addEventListener('click', () => { pickedThread = r.dataset.id; choose(r.dataset.label); }));
    }
  }
  overlay.querySelector('#tg-search').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value.trim()), 250); });
  if (!pickingJob) search('');
  else save.disabled = true;
  if (projectId && pickingJob) save.disabled = false;
  overlay.querySelector('#tg-cancel').addEventListener('click', () => overlay.remove());
  save.addEventListener('click', async () => {
    const msg = overlay.querySelector('#tg-msg');
    if (!pickedProject || !pickedThread) return;
    save.disabled = true;
    const { data: { user } } = await supabaseClient.auth.getUser();
    const { error } = await supabaseClient.from('email_job_links').upsert({
      thread_id: pickedThread, project_id: pickedProject, kind: overlay.querySelector('#tg-kind').value, note: overlay.querySelector('#tg-note').value.trim() || null, created_by: user.id,
    }, { onConflict: 'thread_id,project_id' });
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; save.disabled = false; return; }
    overlay.remove();
    if (onSaved) await onSaved();
  });
}

// ---------- Create a quote or a job from a conversation ----------
// The AI reads the whole conversation and finds the client, the site address and the work
// required (extract-email-job). The person checks and edits it here, then either:
//  - Quote: carried to the new-quote form (via sessionStorage, no URL size limit), or
//  - Job (no quote): created straight away like "+ New job (no quote)".
// Either way the conversation is tagged to the new job so it shows on its Emails tab.
const EMAIL_QUOTE_HANDOFF_KEY = 'te_email_quote_handoff';
const EMAIL_TEMPLATES = { service_work: 'Service work', new_build: 'New build', renovation: 'Renovation', solar: 'Solar proposal', quick_estimate: 'Quick estimate' };

function openCreateFromEmailModal(threadId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:120; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:640px; width:100%; max-height:92vh; overflow-y:auto;">
      <h2 style="margin-top:0;">Create a quote or job from this email</h2>
      <div id="cf-body"><p class="subtitle">Reading the email to find the client, the site and the work required...</p></div>
    </div>`;
  document.body.appendChild(overlay);
  const bodyEl = overlay.querySelector('#cf-body');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  (async () => {
    let result;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/extract-email-job', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const text = await res.text();
      try { result = JSON.parse(text); } catch (e) { throw new Error('Could not read the email (status ' + res.status + '). Try again.'); }
      if (!result.ok) throw new Error(result.error || 'Could not read the email.');
    } catch (err) {
      bodyEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div><button type="button" class="secondary" id="cf-close" style="margin-top:10px;">Close</button>`;
      bodyEl.querySelector('#cf-close').addEventListener('click', () => overlay.remove());
      return;
    }
    const x = result.extracted, existing = result.client;
    const v = (s) => escapeHtml(s || '');
    bodyEl.innerHTML = `
      <p class="subtitle" style="margin:0 0 6px;">Filled in from the email. Check it over and fix anything that is wrong.</p>
      ${existing ? `<div class="success-box" style="margin:8px 0;">Matches existing client <strong>${v(existing.name)}</strong>. <label style="display:inline-flex; gap:6px; align-items:center; margin:0 0 0 8px;"><input type="checkbox" id="cf-use-existing" checked style="width:auto;" /> Link to them</label></div>` : ''}
      ${x.missing.length ? `<div class="error-box" style="margin:8px 0; background:transparent;">Not in the email, worth asking: ${x.missing.map(v).join('; ')}</div>` : ''}
      <label>Create a</label>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0;"><input type="radio" name="cf-kind" value="quote" checked style="width:auto;" /> Quote</label>
        <label style="display:inline-flex; gap:6px; align-items:center; margin:0;"><input type="radio" name="cf-kind" value="job" style="width:auto;" /> Job (no quote)</label>
      </div>
      <div id="cf-template-wrap"><label>Quote template</label>
        <select id="cf-template">${Object.entries(EMAIL_TEMPLATES).map(([k, l]) => `<option value="${k}"${k === x.suggested_template ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <label>Job name</label><input id="cf-title" value="${v(x.job_title || result.subject)}" />
      <div class="grid cols-2">
        <div><label>Client</label><input id="cf-client" value="${v(x.client_name)}" /></div>
        <div><label>Client email</label><input id="cf-email" type="email" value="${v(x.client_email)}" /></div>
        <div><label>Client phone</label><input id="cf-phone" value="${v(x.client_phone)}" /></div>
        <div><label>Site address</label><input id="cf-site" value="${v(x.site_address || x.client_address)}" /></div>
      </div>
      <label>What needs to be done at the site</label>
      <textarea id="cf-work" style="min-height:130px;">${v(x.work_required)}</textarea>
      ${x.urgency || x.other_contact ? `<p class="subtitle" style="margin:6px 0 0; font-size:12px;">${[x.urgency && 'Timing: ' + x.urgency, x.other_contact && 'Other contact: ' + x.other_contact].filter(Boolean).map(v).join(' &middot; ')} (added to the notes)</p>` : ''}
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" id="cf-go">Create quote</button><button type="button" class="secondary" id="cf-cancel">Cancel</button></div>
      <div id="cf-msg" style="margin-top:8px;"></div>`;
    const q = (id) => bodyEl.querySelector(id);
    const kind = () => bodyEl.querySelector('input[name="cf-kind"]:checked').value;
    bodyEl.querySelectorAll('input[name="cf-kind"]').forEach(r => r.addEventListener('change', () => {
      q('#cf-template-wrap').style.display = kind() === 'quote' ? '' : 'none';
      q('#cf-go').textContent = kind() === 'quote' ? 'Create quote' : 'Create job';
    }));
    q('#cf-cancel').addEventListener('click', () => overlay.remove());

    q('#cf-go').addEventListener('click', async () => {
      const msg = q('#cf-msg'), btn = q('#cf-go');
      const form = { name: q('#cf-title').value.trim(), client_name: q('#cf-client').value.trim(), client_email: q('#cf-email').value.trim(), client_phone: q('#cf-phone').value.trim(), address: q('#cf-site').value.trim(), work: q('#cf-work').value.trim() };
      if (!form.client_name) { msg.innerHTML = '<div class="error-box">Client name is required.</div>'; return; }
      if (!form.name) { msg.innerHTML = '<div class="error-box">Give the job a name.</div>'; return; }
      const useExisting = !!existing && q('#cf-use-existing') && q('#cf-use-existing').checked;
      const extraNotes = [x.urgency && `Timing: ${x.urgency}`, x.other_contact && `Other contact: ${x.other_contact}`, x.client_address && x.site_address && x.client_address !== x.site_address && `Client's own address: ${x.client_address}`].filter(Boolean);
      const notes = [`Created from email "${result.subject || '(no subject)'}".`, ...extraNotes].join('\n');
      btn.disabled = true;
      try {
        if (kind() === 'quote') {
          sessionStorage.setItem(EMAIL_QUOTE_HANDOFF_KEY, JSON.stringify({ threadId, ...form, notes, clientId: useExisting ? existing.id : null, attachments: result.attachments || [] }));
          window.location.href = `/new-project.html?from_email=${encodeURIComponent(threadId)}&template=${encodeURIComponent(q('#cf-template').value)}`;
          return;
        }
        btn.textContent = 'Creating...';
        let clientId = useExisting ? existing.id : null;
        if (!clientId) {
          const { data: nc, error: ce } = await supabaseClient.from('clients').insert({ name: form.client_name, email: form.client_email || null, phone: form.client_phone || null, address: form.address || null }).select('id').single();
          if (ce) throw ce;
          clientId = nc.id;
        }
        const { data: project, error } = await supabaseClient.from('projects').insert({
          name: form.name, sow_text: form.work || null, notes, client_id: clientId, client_name: form.client_name,
          client_email: form.client_email || null, client_phone: form.client_phone || null, client_address: form.address || null,
          proposal_template: 'direct_job', pipeline_stage: 'job_booked', status: 'in_progress',
        }).select('id').single();
        if (error) throw error;
        const { error: ccErr } = await supabaseClient.from('cost_centres').insert({ project_id: project.id, name: 'Labour & Materials', sort_order: 0, markup_percent: 45 });
        if (ccErr) throw ccErr;
        await emailTagThreadToProject(threadId, project.id, 'client', 'Job created from this email');
        window.location.href = `/project.html?id=${project.id}&tab=emails`;
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
        btn.disabled = false; btn.textContent = kind() === 'quote' ? 'Create quote' : 'Create job';
      }
    });
  })();
}

// Tags a conversation to a job (idempotent).
async function emailTagThreadToProject(threadId, projectId, kind, note) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  await supabaseClient.from('email_job_links').upsert({ thread_id: threadId, project_id: projectId, kind: kind || 'client', note: note || null, created_by: user ? user.id : null }, { onConflict: 'thread_id,project_id' });
}

// For new-project.html: the details handed over from the inbox for this conversation.
function emailQuoteHandoffRead(threadId) {
  try {
    const raw = sessionStorage.getItem(EMAIL_QUOTE_HANDOFF_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.threadId === threadId ? d : null;
  } catch (e) { return null; }
}
function emailQuoteHandoffClear() { try { sessionStorage.removeItem(EMAIL_QUOTE_HANDOFF_KEY); } catch (e) { /* fine */ } }
