// Job type switch on the job page Summary (5 Nov 2026): a job that did not come from a TEops quote
// (brought across from ServiceM8, or made with "+ New job (no quote)") can be switched between
// Quoted (invoiced as claims against its quoted stages, "Invoice project") and Do and charge
// (invoiced from actual costs, "Invoice actual costs"). Pricing roles only; a job made from a quote
// stays Quoted. Loaded on demand by project.html. Writes projects.proposal_template (new_build or
// direct_job) and an activity log line, then reloads the page so the invoice card follows.

async function renderJobType(project, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !project.job_number || project.source_quote_id) return;
  if (!['new_build', 'direct_job'].includes(project.proposal_template)) return;
  const role = await getMyRole();
  if (!isPricingRole(role)) return;
  const isDoAndCharge = project.proposal_template === 'direct_job';
  el.innerHTML = `<span class="subtitle">Job type:</span>
    <select id="job-type-select" style="width:auto; display:inline-block; margin-left:6px; padding:4px 8px;">
      <option value="new_build" ${isDoAndCharge ? '' : 'selected'}>Quoted (invoice claims against the quote)</option>
      <option value="direct_job" ${isDoAndCharge ? 'selected' : ''}>Do and charge (invoice actual costs)</option>
    </select>`;
  const sel = el.querySelector('#job-type-select');
  sel.addEventListener('change', async () => {
    const to = sel.value;
    const toText = to === 'direct_job' ? 'Do and charge' : 'Quoted';
    if (!confirm(`Switch ${projectRef(project)} to ${toText}? Invoices already raised are not changed.`)) { sel.value = project.proposal_template; return; }
    sel.disabled = true;
    const { error } = await supabaseClient.from('projects').update({ proposal_template: to }).eq('id', project.id);
    if (error) { alert(friendlyError(error)); sel.disabled = false; sel.value = project.proposal_template; return; }
    await logActivity('project', project.id, 'job_type', `Job type set to ${toText} (was ${isDoAndCharge ? 'Do and charge' : 'Quoted'})`);
    location.reload();
  });
}
