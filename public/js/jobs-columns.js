// The Jobs list's columns (backlog item 85): what each column shows, which ones a person has
// switched on and in what order, and the Columns panel that changes it. The choice is saved on the
// person's own profile (profiles.ui_prefs.jobs_columns, migration 20261203000000) so the laptop
// and the phone match, with a copy on the device so the list paints straight away.
// Called by projects.html, which loads the rows. Writes profiles.ui_prefs (the person's own row).

const JOB_TYPE_LABELS = { direct_job: 'Do and charge', new_build: 'New build', solar: 'Solar', battery: 'Battery', quick_estimate: 'Quick estimate', renovation: 'Renovation', service_work: 'Service work' };
// The app's one status colour set (.badge in style.css): grey not started, amber waiting on
// someone else, red needs us, green done, blue (the rest) under way.
const JOB_STAGE_BADGE = { lead: 'draft', draft_quote: 'draft', archived: 'draft', quote_sent: 'amber', awaiting_client_action: 'amber', awaiting_payment: 'amber', awaiting_action: 'red', job_not_complete: 'red', complete: 'complete' };

const JC_DASH = '<span class="subtitle">-</span>';
const JC_WAIT = '<span class="subtitle">...</span>';
// A Sydney day key (2026-11-14) as "Today", "14 Nov" or "Sat 14 Nov"; the year only when it is not this one.
function jcDate(key, today, { weekday = false } = {}) {
  if (!key) return JC_DASH;
  if (key === today) return 'Today';
  const opts = { timeZone: 'UTC', day: 'numeric', month: 'short' };
  if (weekday) opts.weekday = 'short';
  if (key.slice(0, 4) !== today.slice(0, 4)) opts.year = '2-digit';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-AU', opts);
}
const jcFact = (s, html) => (s.factsLoaded ? html() : JC_WAIT);
// Long text (a job name, an address) stays within two lines so every row is the same short height; the full text is the tooltip.
const jcClamp = (html, full, minWidth) => `<div title="${escapeHtml(full || '')}" style="display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-width:${minWidth}px;">${html}</div>`;

// One entry per column, in the default order. on: shown until the person says otherwise.
// cell(p, s): p is the job row projects.html builds; s is { today, costsLoaded, factsLoaded, leftLoaded }.
// The job number is always the first column (it is the row's link) and is not in this list.
const JOBS_COLUMNS = [
  { key: 'name', label: 'Name', on: true, cell: (p) => jcClamp(`<a href="/project.html?id=${encodeURIComponent(p.id)}" style="color:inherit; text-decoration:none;">${escapeHtml(p.name || '')}</a>`, p.name, 160) },
  { key: 'client', label: 'Client', on: true, cell: (p) => jcClamp(escapeHtml(p.client_name || '-'), p.client_name, 100) },
  { key: 'status', label: 'Status', on: true, cell: (p) => `<span class="badge ${JOB_STAGE_BADGE[p.pipeline_stage] || 'info'}" style="white-space:nowrap;">${escapeHtml(pipelineStageLabel(p.pipeline_stage))}</span>` },
  { key: 'address', label: 'Site address', on: true, cell: (p) => (p.client_address ? jcClamp(mapsLink(p.client_address), p.client_address, 150) : JC_DASH) },
  { key: 'created', label: 'Created', on: true, nowrap: true, cell: (p, s) => jcDate(p.created_at ? sydneyDateKey(new Date(p.created_at)) : '', s.today) },
  { key: 'last_on_site', label: 'Last on site', on: true, nowrap: true, cell: (p, s) => jcFact(s, () => jcDate(p.facts?.last_on_site, s.today)) },
  { key: 'next_booked', label: 'Next booked', on: true, nowrap: true, cell: (p, s) => jcFact(s, () => (p.facts?.next_booked ? `<span title="${escapeHtml(p.facts.next_booked_staff || '')}">${jcDate(p.facts.next_booked, s.today, { weekday: true })}</span>` : JC_DASH)) },
  { key: 'signed', label: 'Signed', on: true, num: true, cell: (p) => money(p.signed) },
  { key: 'cost', label: 'Cost outlayed', on: true, num: true, cell: (p, s) => (!s.costsLoaded ? JC_WAIT : p.costOutlayed == null ? JC_DASH : `${money(p.costOutlayed)}${p.costInclOverheads > p.costOutlayed ? `<div class="subtitle" style="font-size:11px; margin:0;">incl. overheads ${money(p.costInclOverheads)}</div>` : ''}`) },
  { key: 'invoiced', label: 'Partial invoiced', on: true, num: true, cell: (p) => money(p.invoiced) },
  { key: 'left', label: 'Left to invoice', on: true, num: true, cell: (p, s) => (p.leftToInvoice != null ? money(p.leftToInvoice) : (s.leftLoaded ? JC_DASH : JC_WAIT)) },
  { key: 'quote', label: 'Quote', cell: (p) => { const q = p.source_quote?.quote_number || p.quote_number; return q ? `Q${escapeHtml(String(q))}` : JC_DASH; } },
  { key: 'phone', label: 'Client phone', nowrap: true, cell: (p) => (p.client_phone ? `<a class="link-quiet" href="tel:${escapeHtml(String(p.client_phone).replace(/[^\d+]/g, ''))}">${escapeHtml(p.client_phone)}</a>` : JC_DASH) },
  { key: 'email', label: 'Client email', cell: (p) => (p.client_email ? `<a class="link-quiet" href="mailto:${escapeHtml(p.client_email)}">${escapeHtml(p.client_email)}</a>` : JC_DASH) },
  { key: 'type', label: 'Job type', cell: (p) => escapeHtml(JOB_TYPE_LABELS[p.proposal_template] || String(p.proposal_template || '-').replace(/_/g, ' ')) },
  { key: 'invoiced_pct', label: 'Invoiced %', num: true, cell: (p) => (p.signed > 0 ? `${Math.round((p.invoiced / p.signed) * 100)}%` : JC_DASH) },
  { key: 'hours', label: 'Hours logged', num: true, cell: (p, s) => (!s.costsLoaded ? JC_WAIT : p.hours == null ? JC_DASH : `${Math.round(p.hours * 10) / 10} h`) },
  { key: 'tasks', label: 'Open tasks', num: true, cell: (p, s) => jcFact(s, () => (p.facts ? String(p.facts.open_tasks) : JC_DASH)) },
  { key: 'pos', label: 'Open POs', num: true, cell: (p, s) => jcFact(s, () => (p.facts ? String(p.facts.open_pos) : JC_DASH)) },
  { key: 'booked_staff', label: 'Booked next (who)', cell: (p, s) => jcFact(s, () => (p.facts?.next_booked_staff ? escapeHtml(p.facts.next_booked_staff) : JC_DASH)) },
];
const jobsColumn = (key) => JOBS_COLUMNS.find((c) => c.key === key);
const jobsColumnsDefault = () => JOBS_COLUMNS.filter((c) => c.on).map((c) => c.key);
// A saved list with anything this version does not know dropped; null when nothing usable was saved.
const jobsColumnsClean = (keys) => (Array.isArray(keys) ? [...new Set(keys)].filter(jobsColumn) : null);

// The table for these rows and columns. devMode adds the bulk-delete tick box column.
function jobsTableHtml(rows, keys, s, devMode) {
  const cols = keys.map(jobsColumn).filter(Boolean);
  return `
    <div style="overflow-x:auto;">
    <table class="responsive-stack">
      <thead><tr>${devMode ? '<th></th>' : ''}<th>#</th>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((p) => `
          <tr class="project-row-link" style="cursor:pointer;">
            ${devMode ? `<td data-label=""><input type="checkbox" class="project-select" data-id="${escapeHtml(p.id)}" style="width:auto;" /></td>` : ''}
            <td data-label="#"><a class="project-link" href="/project.html?id=${encodeURIComponent(p.id)}" style="color:inherit; text-decoration:none;">${escapeHtml(p.job_number ? 'J' + p.job_number : (p.quote_number ? 'Q' + p.quote_number : '-'))}</a></td>
            ${cols.map((c) => `<td data-label="${escapeHtml(c.label)}"${c.num ? ' class="num"' : ''}${c.num || c.nowrap ? ' style="white-space:nowrap;"' : ''}>${c.cell(p, s)}</td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table>
    </div>`;
}

const JOBS_COLUMNS_KEY = 'te-jobs-columns';
// The device's copy (or the default set): what the list paints with before the profile answers.
function jobsColumnsCached() {
  try { return jobsColumnsClean(JSON.parse(localStorage.getItem(JOBS_COLUMNS_KEY))) || jobsColumnsDefault(); } catch (e) { return jobsColumnsDefault(); }
}
function jobsColumnsCache(keys) {
  try { localStorage.setItem(JOBS_COLUMNS_KEY, JSON.stringify(keys)); } catch (e) { /* storage blocked: the profile copy still works */ }
}
async function jobsUiPrefs() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Not logged in');
  const { data, error } = await supabaseClient.from('profiles').select('ui_prefs').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  return { userId: session.user.id, prefs: (data && data.ui_prefs) || {} };
}
// The columns saved on the profile, or null when none are saved (or it could not be read: the
// device's copy carries on).
async function loadJobsColumns() {
  try {
    const keys = jobsColumnsClean((await jobsUiPrefs()).prefs.jobs_columns);
    if (keys) jobsColumnsCache(keys);
    return keys;
  } catch (err) {
    console.error('Jobs columns not read from the profile:', err.message);
    return null;
  }
}
// Saves to the device now and to the profile half a second after the last change (a drag makes
// several). The profile is read first so anything else kept in ui_prefs stays. onSaved(error).
let jobsColumnsSaveTimer = null;
function saveJobsColumns(keys, onSaved) {
  jobsColumnsCache(keys);
  clearTimeout(jobsColumnsSaveTimer);
  jobsColumnsSaveTimer = setTimeout(async () => {
    let failed = null;
    try {
      const { userId, prefs } = await jobsUiPrefs();
      const { error } = await supabaseClient.from('profiles').update({ ui_prefs: { ...prefs, jobs_columns: keys } }).eq('id', userId);
      if (error) throw error;
    } catch (err) {
      failed = err;
      console.error('Jobs columns not saved to the profile:', err.message);
    }
    if (onSaved) onSaved(failed);
  }, 500);
}

// The Columns panel. visible: the keys showing now. onChange(keys) runs on every tick, move and
// reset, so the list behind redraws straight away; the save follows by itself.
function openJobsColumnsPanel(visible, onChange) {
  let order = [...visible, ...JOBS_COLUMNS.map((c) => c.key).filter((k) => !visible.includes(k))];
  let on = new Set(visible);
  const overlay = openModal(`
    <h2>Columns</h2>
    <p class="subtitle" style="margin-bottom:8px;">Tick what to show. Drag a row, or use the arrows, to change the order. Saved for you on every device.</p>
    <div id="jc-list"></div>
    <div id="jc-msg"></div>
    <div style="display:flex; gap:8px; margin-top:12px;">
      <button type="button" id="jc-done">Done</button>
      <button type="button" class="secondary" id="jc-reset">Reset to default</button>
    </div>`, { maxWidth: 400, closeOnBackdrop: true });
  const list = overlay.querySelector('#jc-list');
  const msg = overlay.querySelector('#jc-msg');
  function draw() {
    list.innerHTML = order.map((k, i) => `
      <div class="jc-row" draggable="true" data-i="${i}" style="display:flex; align-items:center; gap:8px; padding:3px 0; border-bottom:1px solid var(--border);">
        <span aria-hidden="true" style="cursor:grab; color:var(--muted);">&#8942;&#8942;</span>
        <label style="flex:1; display:flex; align-items:center; gap:8px; margin:0; font-weight:400; cursor:pointer;"><input type="checkbox" data-k="${k}" style="width:auto; margin:0;" ${on.has(k) ? 'checked' : ''} /> ${escapeHtml(jobsColumn(k).label)}</label>
        <button type="button" class="secondary btn-sm" data-move="-1" title="Move up" ${i ? '' : 'disabled'}>&uarr;</button>
        <button type="button" class="secondary btn-sm" data-move="1" title="Move down" ${i < order.length - 1 ? '' : 'disabled'}>&darr;</button>
      </div>`).join('');
  }
  function apply() {
    const keys = order.filter((k) => on.has(k));
    onChange(keys);
    saveJobsColumns(keys, (error) => {
      if (!msg.isConnected) return;
      msg.innerHTML = error ? '<div class="error-box">Saved on this device only: your profile could not be reached, so other devices keep their own columns for now.</div>' : '';
    });
  }
  function move(from, to) {
    if (to < 0 || to >= order.length || to === from) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    draw();
    apply();
  }
  list.addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (e.target.checked) on.add(k); else on.delete(k);
    apply();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const i = Number(btn.closest('.jc-row').dataset.i);
    move(i, i + Number(btn.dataset.move));
  });
  // Drag with a mouse; the arrows do the same job on a touch screen.
  let dragFrom = null;
  const mark = (row) => list.querySelectorAll('.jc-row').forEach((r) => { r.style.boxShadow = r === row ? 'inset 0 2px 0 var(--accent)' : ''; });
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.jc-row');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  list.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    mark(e.target.closest('.jc-row'));
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.jc-row');
    const from = dragFrom;
    dragFrom = null;
    mark(null);
    if (row && from !== null) move(from, Number(row.dataset.i));
  });
  list.addEventListener('dragend', () => { dragFrom = null; mark(null); });
  overlay.querySelector('#jc-reset').addEventListener('click', () => {
    const def = jobsColumnsDefault();
    order = [...def, ...JOBS_COLUMNS.map((c) => c.key).filter((k) => !def.includes(k))];
    on = new Set(def);
    draw();
    apply();
  });
  overlay.querySelector('#jc-done').addEventListener('click', () => overlay.remove());
  draw();
}
