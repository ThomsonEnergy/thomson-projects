// Merge a client's jobs into one job (docs/IDEAS_BACKLOG.md item 47, spec A13e). Loaded on demand by
// project.html for the Summary: the "J7010 was merged into this job" note when the page was reached
// through an old J number (merged_from in the address), the list of jobs already merged in (pricing
// roles, project_merges), and for Admin the "Merge another job into this one" button: pick the
// client's other jobs, see what will move (project_merge_preview), Merge (project_merge, one
// database step, all or nothing), then the page reloads. Writes nothing itself.

const MERGE_COUNT_LABELS = [['stages', 'stage'], ['shifts', 'shift'], ['purchase_orders', 'PO'], ['bills', 'bill'], ['invoices', 'invoice'],
  ['variations', 'variation'], ['tasks', 'task'], ['documents', 'document'], ['photos', 'photo'], ['bookings', 'booking'], ['notes', 'note'],
  ['materials_used', 'material used'], ['stcs', 'STC claim'], ['assets', 'asset'], ['inspections', 'inspection'], ['emails', 'email'], ['contacts', 'contact']];

function mergeCountsText(counts) {
  const parts = MERGE_COUNT_LABELS.map(([k, label]) => { const n = Number(counts?.[k]) || 0; return n ? `${n} ${label}${n === 1 ? '' : (label === 'PO' ? 's' : 's')}` : ''; }).filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing on it yet';
}

async function renderJobMerge(project, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const mergedFrom = new URLSearchParams(location.search).get('merged_from');
  const role = await getMyRole();
  const parts = [];
  if (mergedFrom) {
    const { data: old } = await supabaseClient.from('projects').select('job_number, name, merged_at').eq('id', mergedFrom).maybeSingle();
    if (old?.merged_at) {
      const when = new Date(old.merged_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
      parts.push(`<div class="success-box" style="margin-bottom:8px;">J${escapeHtml(old.job_number)} (${escapeHtml(old.name)}) was merged into this job on ${escapeHtml(when)}. Its stages are here as "J${escapeHtml(old.job_number)}: ...".</div>`);
    }
  }
  if (isPricingRole(role) && project.job_number) {
    const { data: merges } = await supabaseClient.from('project_merges').select('from_job_number, created_at').eq('into_project_id', project.id).order('created_at');
    if ((merges || []).length) parts.push(`<p class="subtitle" style="font-size:12px; margin:0 0 6px;">Merged in: ${merges.map(m => `J${escapeHtml(m.from_job_number)}`).join(', ')}</p>`);
  }
  if (role === 'admin' && project.job_number && !project.merged_into_project_id) {
    parts.push(`<button type="button" class="secondary" id="merge-jobs-btn" style="font-size:12px; padding:6px 10px;">Merge another job into this one</button>`);
  }
  el.innerHTML = parts.join('');
  const btn = el.querySelector('#merge-jobs-btn');
  if (btn) btn.addEventListener('click', () => openMergeJobsPanel(project));
}

async function openMergeJobsPanel(project) {
  const overlay = openModal(`<h2>Merge another job into ${escapeHtml(projectRef(project))}</h2><p class="subtitle">Loading the client's other jobs...</p>`, { maxWidth: 560 });
  const q = (sel) => overlay.querySelector(sel);
  let query = supabaseClient.from('projects').select('id, name, job_number, client_name, pipeline_stage')
    .neq('id', project.id).not('job_number', 'is', null).is('merged_into_project_id', null).not('pipeline_stage', 'in', '("complete","archived")');
  query = project.client_id ? query.eq('client_id', project.client_id) : query.eq('client_name', project.client_name);
  const { data: jobs, error } = await query.order('job_number');
  if (error) { overlay.querySelector('.card').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div><button type="button" class="secondary" id="mj-close">Close</button>`; q('#mj-close').addEventListener('click', () => overlay.remove()); return; }
  overlay.querySelector('.card').innerHTML = `
    <h2>Merge another job into ${escapeHtml(projectRef(project))}</h2>
    <p class="subtitle" style="margin-bottom:10px;">${escapeHtml(project.client_name || 'This client')}'s other open jobs. Each one's stages come across as "J...: stage" with everything on them (shifts, POs, bills, invoices, tasks, documents, photos, bookings). The old J number keeps opening this job. There is no undo button.</p>
    ${(jobs || []).length ? `<div id="mj-list">${jobs.map(j => `<label style="display:flex; align-items:center; gap:8px; font-weight:400; margin:4px 0;"><input type="checkbox" class="mj-pick" value="${escapeHtml(j.id)}" style="width:auto;" /> ${escapeHtml(projectRef(j))} <span class="subtitle" style="font-size:11px;">${escapeHtml((j.pipeline_stage || '').replace(/_/g, ' '))}</span></label>`).join('')}</div>`
      : `<p class="subtitle">No other open jobs for this client. Complete or archived jobs are not offered: reopen one first if it should be merged.</p>`}
    <div id="mj-preview" style="margin-top:10px;"></div>
    <div style="margin-top:14px; display:flex; gap:8px;">
      ${(jobs || []).length ? `<button type="button" id="mj-next">See what will move</button>` : ''}
      <button type="button" class="secondary" id="mj-cancel">Cancel</button>
    </div>
    <div id="mj-msg"></div>`;
  q('#mj-cancel').addEventListener('click', () => overlay.remove());
  const next = q('#mj-next');
  if (!next) return;
  next.addEventListener('click', async () => {
    const ids = [...overlay.querySelectorAll('.mj-pick:checked')].map(c => c.value);
    const msg = q('#mj-msg');
    if (!ids.length) { msg.innerHTML = '<div class="error-box">Tick at least one job.</div>'; return; }
    next.disabled = true; next.textContent = 'Counting...';
    const { data: preview, error: pErr } = await supabaseClient.rpc('project_merge_preview', { p_from: ids });
    if (pErr) { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(pErr))}</div>`; next.disabled = false; next.textContent = 'See what will move'; return; }
    msg.innerHTML = '';
    q('#mj-preview').innerHTML = `<div style="border:1px solid var(--border); border-radius:8px; padding:8px;">
      ${(preview || []).map(p => `<p style="margin:4px 0; font-size:13px;"><strong>J${escapeHtml(p.job_number)} ${escapeHtml(p.name)}</strong>: ${escapeHtml(mergeCountsText(p.counts))}</p>`).join('')}
      <p class="subtitle" style="font-size:12px; margin:6px 0 0;">Nothing is re-costed and no invoice changes. Both jobs' activity logs record the move.</p>
    </div>`;
    next.textContent = `Merge ${ids.length === 1 ? 'this job' : `these ${ids.length} jobs`} into ${projectRef(project)}`;
    next.disabled = false;
    next.onclick = async () => {
      if (!confirm(`Merge ${ids.length === 1 ? 'this job' : `these ${ids.length} jobs`} into ${projectRef(project)}? There is no undo button.`)) return;
      next.disabled = true; next.textContent = 'Merging...';
      const { data, error: mErr } = await supabaseClient.rpc('project_merge', { p_into: project.id, p_from: ids });
      if (mErr) { msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(mErr))}</div>`; next.disabled = false; next.textContent = 'Try again'; return; }
      showToast(`${(data?.merged || []).join(', ')} merged into J${data?.into_job_number}`);
      overlay.remove();
      location.reload();
    };
  });
}
