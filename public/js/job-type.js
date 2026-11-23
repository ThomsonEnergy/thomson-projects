// Job type switch on the job page Summary (5 Nov 2026): a job that did not come from a TEops quote
// (brought across from ServiceM8, or made with "+ New job (no quote)") can be switched between
// Quoted (invoiced as claims against its quoted stages, "Invoice project") and Do and charge
// (invoiced from actual costs, "Invoice actual costs"). Pricing roles only; a job made from a quote
// stays Quoted. Loaded on demand by project.html. Writes projects.proposal_template (new_build or
// direct_job) and an activity log line, then reloads the page so the invoice card follows.
//
// A third type (item 109): Disconnect and reconnect, a do and charge job billed from the price list.
// Picking it runs service-job.js "setup" (the job is marked, its one cost centre becomes Disconnection,
// Reconnection and the sheets are added); refused there once the job has an invoice. A price list job
// stays one, and shows its card under the type (js/job-service.js) to everyone on the job.

async function renderJobType(project, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !project.job_number || project.source_quote_id) return;
  if (!['new_build', 'direct_job'].includes(project.proposal_template)) return;
  const role = await getMyRole();
  if (project.service_price_job) {
    el.innerHTML = '<span class="subtitle">Job type:</span> <strong>Disconnect and reconnect</strong> <span class="subtitle">(billed from the price list)</span><div id="job-service-area" style="margin-top:8px;"></div>';
    await loadJsOnce('/js/job-service.js?v=1', () => typeof renderJobService === 'function');
    renderJobService(project, document.getElementById('job-service-area'), isPricingRole(role));
    return;
  }
  if (!isPricingRole(role)) return;
  const isDoAndCharge = project.proposal_template === 'direct_job';
  el.innerHTML = `<span class="subtitle">Job type:</span>
    <select id="job-type-select" style="width:auto; display:inline-block; margin-left:6px; padding:4px 8px;">
      <option value="new_build" ${isDoAndCharge ? '' : 'selected'}>Quoted (invoice claims against the quote)</option>
      <option value="direct_job" ${isDoAndCharge ? 'selected' : ''}>Do and charge (invoice actual costs)</option>
      <option value="service">Disconnect and reconnect (invoice from the price list)</option>
    </select>`;
  const sel = el.querySelector('#job-type-select');
  sel.addEventListener('change', async () => {
    const to = sel.value;
    if (to === 'service') {
      if (!confirm(`Switch ${projectRef(project)} to Disconnect and reconnect? It will be billed from the price list, not from time. Hours and materials already on the job stay under Disconnection. This cannot be switched back.`)) { sel.value = project.proposal_template; return; }
      sel.disabled = true;
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const res = await fetch('/.netlify/functions/service-job', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: 'setup', projectId: project.id }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) throw new Error(out.error || 'Could not switch the job');
        location.reload();
      } catch (err) { alert(friendlyError(err)); sel.disabled = false; sel.value = project.proposal_template; }
      return;
    }
    const toText = to === 'direct_job' ? 'Do and charge' : 'Quoted';
    if (!confirm(`Switch ${projectRef(project)} to ${toText}? Invoices already raised are not changed.`)) { sel.value = project.proposal_template; return; }
    sel.disabled = true;
    const { error } = await supabaseClient.from('projects').update({ proposal_template: to }).eq('id', project.id);
    if (error) { alert(friendlyError(error)); sel.disabled = false; sel.value = project.proposal_template; return; }
    await logActivity('project', project.id, 'job_type', `Job type set to ${toText} (was ${isDoAndCharge ? 'Do and charge' : 'Quoted'})`);
    location.reload();
  });
}
