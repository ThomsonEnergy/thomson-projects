// The Jobs list's columns (backlog item 85): what each column shows, and which ones a person has
// switched on and in what order. The choice is saved on the person's own profile
// (profiles.ui_prefs.jobs_columns, migration 20261203000000) so the laptop and the phone match,
// with a copy on the device so the list paints straight away. The Columns panel that changes it
// is js/jobs-columns-panel.js, loaded when the button is pressed.
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
  { key: 'quote', label: 'Quote', cell: (p) => (p.quoteNumber ? `Q${escapeHtml(String(p.quoteNumber))}` : JC_DASH) },
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
// The device's copy: { u: whose it is, k: the keys, d: true while a change has not reached the profile }.
function jobsColumnsDevice() {
  try { const v = JSON.parse(localStorage.getItem(JOBS_COLUMNS_KEY)); return v && Array.isArray(v.k) ? v : null; } catch (e) { return null; }
}
function jobsColumnsCache(userId, keys, unsaved) {
  try { localStorage.setItem(JOBS_COLUMNS_KEY, JSON.stringify({ u: userId, k: keys, d: !!unsaved })); } catch (e) { /* storage blocked: the profile copy still works */ }
}
// What the list paints with before the profile answers.
function jobsColumnsCached() {
  const dev = jobsColumnsDevice();
  return (dev && jobsColumnsClean(dev.k)) || jobsColumnsDefault();
}
async function jobsColumnsSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Not logged in');
  return session.user.id;
}
async function jobsUiPrefs(userId) {
  const { data, error } = await supabaseClient.from('profiles').select('ui_prefs').eq('id', userId).maybeSingle();
  if (error) throw error;
  return (data && data.ui_prefs) || {};
}
// The person's columns once the profile has answered. The profile wins (another device may have
// changed them), except over a change made on this device that never reached it (the page was
// left first, or the save failed): that one is kept and sent again. Someone else's device copy is
// never inherited. null only when nobody is logged in.
let jobsColumnsUser = null;
async function loadJobsColumns() {
  let userId;
  try { userId = await jobsColumnsSession(); } catch (err) { return null; }
  jobsColumnsUser = userId;
  const dev = jobsColumnsDevice();
  const mine = dev && dev.u === userId ? jobsColumnsClean(dev.k) : null;
  if (mine && dev.d) { saveJobsColumns(mine); return mine; }
  let saved = null;
  try { saved = jobsColumnsClean((await jobsUiPrefs(userId)).jobs_columns); } catch (err) { console.error('Jobs columns not read from the profile:', err.message); }
  // a change made in the panel while the profile was being read is newer than its answer
  const now = jobsColumnsDevice();
  if (now && now.u === userId && now.d) return jobsColumnsClean(now.k);
  const keys = saved || mine || jobsColumnsDefault();
  jobsColumnsCache(userId, keys, false);
  return keys;
}
// Saves to the device now (marked unsaved) and to the profile half a second after the last change
// (a drag makes several). The profile is read first so anything else kept in ui_prefs stays.
// onSaved(error) when the profile has answered.
let jobsColumnsSaveTimer = null;
function saveJobsColumns(keys, onSaved) {
  jobsColumnsCache(jobsColumnsUser || (jobsColumnsDevice() || {}).u || null, keys, true);
  clearTimeout(jobsColumnsSaveTimer);
  jobsColumnsSaveTimer = setTimeout(async () => {
    let failed = null;
    try {
      const userId = await jobsColumnsSession();
      const prefs = await jobsUiPrefs(userId);
      const { error } = await supabaseClient.from('profiles').update({ ui_prefs: { ...prefs, jobs_columns: keys } }).eq('id', userId);
      if (error) throw error;
      jobsColumnsCache(userId, keys, false);
    } catch (err) {
      failed = err;
      console.error('Jobs columns not saved to the profile:', err.message);
    }
    if (onSaved) onSaved(failed);
  }, 500);
}
