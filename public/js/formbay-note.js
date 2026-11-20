// The Formbay accredited installer, shown to whoever books a job (item 101d).
//   formbayInstallerNote(projectId, anchor)   puts one amber line above `anchor` and marks that
//                                             person in any staff tick list in the same card
// Used by the job's Schedule tab (job-schedule.js), its Book people panel (project.html) and the
// Schedule page's day board (schedule.html). An FYI only: it never stops a booking.
// Reads the database function formbay_installers (names only; the form itself is pricing roles only).

async function formbayInstallerNote(projectId, anchor) {
  if (!projectId || !anchor || !anchor.parentNode) return;
  const { data, error } = await supabaseClient.rpc('formbay_installers', { p_project_id: projectId });
  let el = anchor.parentNode.querySelector(':scope > .formbay-note');
  const rows = error ? [] : (data || []);
  if (!rows.length) { if (el) el.remove(); return; }
  // one line per person: "the solar form", "the battery form" or "the solar and battery forms"
  const kinds = {};
  rows.forEach(r => { (kinds[r.installer] = kinds[r.installer] || []).push(r.ftype === 'pv' ? 'solar' : 'battery'); });
  if (!el) { el = document.createElement('div'); el.className = 'formbay-note'; anchor.parentNode.insertBefore(el, anchor); }
  el.innerHTML = Object.keys(kinds).map(name => `
    <p style="margin:0 0 10px; padding:8px 10px; border-radius:8px; background:var(--amber-dim); color:var(--amber);">
      Formbay: <strong>${escapeHtml(name)}</strong> is the accredited installer on this job's ${escapeHtml(kinds[name].join(' and '))} form${kinds[name].length > 1 ? 's' : ''}
      and must be on site for the three on site photos (check in, mid install, testing and commissioning).
    </p>`).join('');
  const card = anchor.closest('.card');
  if (card) {
    card.querySelectorAll('label').forEach(label => {
      if (!label.querySelector('.sched-staff') || label.querySelector('.formbay-mark')) return;
      if (kinds[label.textContent.trim()]) label.insertAdjacentHTML('beforeend', ' <span class="badge amber formbay-mark">Formbay installer</span>');
    });
  }
}
