// Pipeline stage picker in the job page header (20 Nov 2026): for pricing roles the read-only
// stage badge becomes a dropdown, so a job is moved along the pipeline without leaving it.
// The same plain move as the Job Pipeline board and Schedule > Plan: the database rules still
// refuse a move that is not allowed and the reason shows in a toast. Everyone else keeps the badge.
// Loaded on demand by project.html (render). Writes projects.pipeline_stage, then loads and draws
// the job again (loadProject, render) so every card that follows the stage is right.

const JOB_STAGE_QUOTE_KEYS = ['lead', 'draft_quote', 'quote_sent'];

async function initJobStagePicker(project) {
  const badge = document.getElementById('pipeline-stage-badge');
  if (!badge || badge.tagName === 'SELECT' || !project.job_number) return;
  if (typeof editMode !== 'undefined' && editMode) return; // Edit stages has unsaved typing: a move would reload over it
  if (!isPricingRole(await getMyRole())) return;
  if (!badge.isConnected) return; // the page drew again while the role was read

  // A job picks from Quote Approved to Complete, plus Archived (and the stage it is on now, whatever it is).
  const stages = PIPELINE_STAGES.filter(s => !JOB_STAGE_QUOTE_KEYS.includes(s.key) || s.key === project.pipeline_stage)
    .concat([{ key: 'archived', label: 'Archived' }]);
  const sel = document.createElement('select');
  sel.id = badge.id;
  sel.className = badge.className;
  sel.title = 'Pipeline stage: pick one to move this job';
  sel.setAttribute('aria-label', 'Pipeline stage');
  sel.style.cssText = 'width:auto; max-width:100%; display:inline-block; margin:0; padding:3px 6px; cursor:pointer; font-family:inherit;';
  sel.innerHTML = stages.map(s => `<option value="${escapeHtml(s.key)}" ${s.key === project.pipeline_stage ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
  badge.replaceWith(sel);

  // The page sets this box by itself when a task tick moves the job, so "was" is read at the tap.
  let was = sel.value;
  sel.addEventListener('focus', () => { was = sel.value; });
  sel.addEventListener('change', async () => {
    const to = sel.value;
    if (to === was) return;
    sel.disabled = true;
    const { data: row, error } = await supabaseClient.from('projects').update({ pipeline_stage: to }).eq('id', project.id).select('pipeline_stage').single();
    if (error || !row) {
      sel.value = was;
      sel.disabled = false;
      showToast('Could not move: ' + friendlyError(error || new Error('no row returned')), { error: true });
      return;
    }
    was = row.pipeline_stage;
    sel.disabled = false;
    showToast(`${projectNumberOnly(project)} moved to ${pipelineStageLabel(row.pipeline_stage)}.`);
    // Draw the job again (render always opens Summary) and go back to the tab that was open.
    const onTab = document.querySelector('#job-tabs .settings-tab.active')?.dataset.panel;
    const refreshed = await loadProject();
    if (!refreshed || (typeof editMode !== 'undefined' && editMode)) return;
    render(refreshed, true);
    if (onTab && onTab !== 'summary') document.querySelector(`#job-tabs .settings-tab[data-panel="${onTab}"]`)?.click();
  });
}
